import { CartAddEvent } from '@theme/events';
import { formatMoney } from '@theme/money-formatting';

/**
 * Cart upsell / cross-sell carousel.
 *
 * Fetches recommendations for the most recently added cart item and renders a
 * paginated list of add-on products. Recommendation sources are tried in order:
 *
 *   1. `complementary` - pairings set in the Search & Discovery app
 *   2. `related`       - Shopify's automatic recommendations (optional fallback)
 *   3. a collection    - rendered into the element as JSON (optional fallback)
 *
 * Products already in the cart are never shown.
 */
class CartUpsell extends HTMLElement {
  /** @type {Array<Object>} */
  #products = [];
  #page = 0;
  #started = false;

  connectedCallback() {
    if (this.#started) return;
    this.#started = true;
    this.#load();
  }

  get #perPage() {
    return Math.max(1, Number.parseInt(this.dataset.perPage || '2', 10));
  }

  get #limit() {
    return Math.max(1, Number.parseInt(this.dataset.limit || '6', 10));
  }

  /** Product ids already in the cart, which must never be recommended. */
  get #excluded() {
    return (this.dataset.exclude || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  get #pageCount() {
    return Math.max(1, Math.ceil(this.#products.length / this.#perPage));
  }

  async #load() {
    const { productId, url } = this.dataset;
    let products = [];

    if (productId && url) {
      const intent = this.dataset.intent || 'complementary';
      products = await this.#fetchRecommendations(url, productId, intent);

      // Fall back to Shopify's automatic recommendations when no pairings exist.
      if (!products.length && this.dataset.fallbackRelated === 'true' && intent !== 'related') {
        products = await this.#fetchRecommendations(url, productId, 'related');
      }
    }

    if (!products.length) products = this.#fallbackProducts();

    const excluded = this.#excluded;
    this.#products = products
      .filter((product) => product && product.available !== false && !excluded.includes(String(product.id)))
      .slice(0, this.#limit);

    this.#render();
  }

  /**
   * @param {string} baseUrl - The product recommendations URL (`.json` endpoint)
   * @param {string} productId - The product to base recommendations on
   * @param {string} intent - `complementary` or `related`
   * @returns {Promise<Array<Object>>}
   */
  async #fetchRecommendations(baseUrl, productId, intent) {
    try {
      const url = `${baseUrl}?product_id=${encodeURIComponent(productId)}&limit=${this.#limit}&intent=${intent}`;
      const response = await fetch(url);
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data.products) ? data.products : [];
    } catch {
      return [];
    }
  }

  /** Products from the merchant-selected fallback collection, if any. */
  #fallbackProducts() {
    const script = this.querySelector('[data-upsell-fallback]');
    if (!script) return [];
    try {
      const parsed = JSON.parse(script.textContent || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Resizes a Shopify CDN image URL.
   * @param {string | null} src
   * @param {number} width
   */
  #imageUrl(src, width) {
    if (!src) return '';
    return `${src}${src.includes('?') ? '&' : '?'}width=${width}`;
  }

  /** @param {number} cents */
  #money(cents) {
    return formatMoney(cents, this.dataset.moneyFormat || '${{amount}}', this.dataset.currency || 'USD');
  }

  #render() {
    // Nothing to recommend: stay invisible rather than leaving an empty heading.
    if (!this.#products.length) {
      this.hidden = true;
      this.replaceChildren();
      return;
    }

    this.hidden = false;
    if (!this.querySelector('[data-upsell-list]')) this.#renderShell();
    this.#renderPage();
  }

  /**
   * Builds the heading, list and pagination once. Paging only swaps the list
   * contents: replacing the arrow that was clicked would detach the click
   * target, and the cart drawer treats clicks on detached nodes as clicks
   * outside the drawer and closes it.
   */
  #renderShell() {
    this.innerHTML = `
      <h3 class="cart-upsell__heading">${this.#escape(this.dataset.heading || '')}</h3>
      <ul class="cart-upsell__list" role="list" data-upsell-list></ul>
      <div class="cart-upsell__nav" data-upsell-nav>
        <button type="button" class="cart-upsell__arrow" data-upsell-prev aria-label="Previous">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <span class="cart-upsell__count" data-upsell-count aria-live="polite"></span>
        <button type="button" class="cart-upsell__arrow" data-upsell-next aria-label="Next">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
    `;

    this.querySelector('[data-upsell-prev]')?.addEventListener('click', () => this.#goTo(this.#page - 1));
    this.querySelector('[data-upsell-next]')?.addEventListener('click', () => this.#goTo(this.#page + 1));
  }

  /** @param {number} page */
  #goTo(page) {
    this.#page = (page + this.#pageCount) % this.#pageCount;
    this.#renderPage();
  }

  #renderPage() {
    this.#page = Math.min(this.#page, this.#pageCount - 1);

    const start = this.#page * this.#perPage;
    const visible = this.#products.slice(start, start + this.#perPage);

    const list = this.querySelector('[data-upsell-list]');
    if (list) list.innerHTML = visible.map((product) => this.#card(product)).join('');

    const nav = this.querySelector('[data-upsell-nav]');
    if (nav instanceof HTMLElement) nav.hidden = this.#pageCount <= 1;

    const count = this.querySelector('[data-upsell-count]');
    if (count) count.textContent = `${this.#page + 1}/${this.#pageCount}`;

    this.#bindCards();
  }

  /** @param {Object} product */
  #card(product) {
    const variants = Array.isArray(product.variants) ? product.variants.filter((v) => v.available) : [];
    const variant = variants[0];
    if (!variant) return '';

    const image = this.#imageUrl(product.featured_image || product.images?.[0] || null, 200);
    const onSale = product.compare_at_price && product.compare_at_price > product.price;

    const variantSelect =
      variants.length > 1
        ? `<select class="cart-upsell__select" data-upsell-variant aria-label="${this.#escape(product.options?.[0] || 'Variant')}">
             ${variants
               .map((v) => `<option value="${v.id}" data-price="${v.price}">${this.#escape(v.title)}</option>`)
               .join('')}
           </select>`
        : '';

    return `
      <li class="cart-upsell__item" data-upsell-card data-product-id="${product.id}">
        <a class="cart-upsell__media" href="${this.#escape(product.url || `/products/${product.handle}`)}" tabindex="-1">
          ${
            image
              ? `<img class="cart-upsell__image" src="${image}" alt="${this.#escape(product.title)}" loading="lazy" width="64" height="64">`
              : '<span class="cart-upsell__image cart-upsell__image--empty"></span>'
          }
        </a>
        <div class="cart-upsell__info">
          <a class="cart-upsell__title" href="${this.#escape(product.url || `/products/${product.handle}`)}">${this.#escape(product.title)}</a>
          <p class="cart-upsell__price">
            <span data-upsell-price>${this.#money(variant.price)}</span>
            ${onSale ? `<s class="cart-upsell__compare">${this.#money(product.compare_at_price)}</s>` : ''}
          </p>
          ${variantSelect}
        </div>
        <button type="button" class="${this.#escape(this.dataset.buttonClass || 'button')} cart-upsell__add" data-upsell-add data-variant-id="${variant.id}">
          ${this.#escape(this.dataset.addLabel || 'Add')}
        </button>
      </li>
    `;
  }

  #bindCards() {
    // Keep the price and the add button in sync with the chosen variant.
    this.querySelectorAll('[data-upsell-variant]').forEach((select) => {
      select.addEventListener('change', (event) => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLSelectElement)) return;
        const card = target.closest('[data-upsell-card]');
        const option = target.selectedOptions[0];
        if (!card || !option) return;

        const addButton = card.querySelector('[data-upsell-add]');
        if (addButton instanceof HTMLElement) addButton.dataset.variantId = target.value;

        const price = card.querySelector('[data-upsell-price]');
        if (price) price.textContent = this.#money(Number(option.dataset.price));
      });
    });

    this.querySelectorAll('[data-upsell-add]').forEach((button) => {
      button.addEventListener('click', (event) => this.#add(event));
    });
  }

  /** @param {Event} event */
  async #add(event) {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;

    const variantId = button.dataset.variantId;
    if (!variantId || button.disabled) return;

    const card = button.closest('[data-upsell-card]');
    const productId = card instanceof HTMLElement ? card.dataset.productId : undefined;

    // Keep the label (it's translated) and signal progress via state only.
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');

    try {
      // Ask for the cart sections back so the drawer/page can re-render in place.
      const sectionIds = Array.from(document.querySelectorAll('cart-items-component'))
        .map((node) => (node instanceof HTMLElement ? node.dataset.sectionId : null))
        .filter(Boolean);

      const body = new FormData();
      body.set('id', variantId);
      body.set('quantity', '1');
      if (sectionIds.length) body.set('sections', sectionIds.join(','));

      const response = await fetch(Theme.routes.cart_add_url, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body,
      });
      const result = await response.json();

      if (result.status) throw new Error(result.description || result.message);

      const cart = await fetch(`${Theme.routes.cart_url}.js`)
        .then((res) => (res.ok ? res.json() : undefined))
        .catch(() => undefined);

      this.dispatchEvent(
        new CartAddEvent(cart ?? {}, this.id || 'cart-upsell', {
          source: 'cart-upsell',
          itemCount: 1,
          productId,
          variantId,
          sections: result.sections,
        })
      );

      // Drop it from the list in case the cart doesn't re-render this element.
      this.#products = this.#products.filter((product) => String(product.id) !== String(productId));
      this.#render();
    } catch (error) {
      console.error('Cart upsell add failed:', error);
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  /** @param {string} value */
  #escape(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }
}

if (!customElements.get('cart-upsell')) {
  customElements.define('cart-upsell', CartUpsell);
}
