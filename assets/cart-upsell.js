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
 *
 * The cart drawer and page are updated by morphing in server-rendered HTML. The
 * element is marked `data-skip-subtree-update`, so morphing leaves the rendered
 * products alone and only syncs the data attributes; when the cart contents
 * change, `attributeChangedCallback` reloads the recommendations.
 */
class CartUpsell extends HTMLElement {
  static observedAttributes = ['data-product-id', 'data-exclude'];

  /** @type {Array<Object>} */
  #products = [];
  /** @type {Array<Object> | null} */
  #fallback = null;
  #started = false;
  #loadId = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #reloadTimer;

  connectedCallback() {
    if (this.#started) return;
    this.#started = true;
    this.#load();
  }

  disconnectedCallback() {
    clearTimeout(this.#reloadTimer);
  }

  /**
   * @param {string} _name
   * @param {string | null} oldValue
   * @param {string | null} newValue
   */
  attributeChangedCallback(_name, oldValue, newValue) {
    if (!this.#started || oldValue === newValue) return;

    // A morph can change several attributes in a row; reload once.
    clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => this.#load());
  }

  /** How many products are visible at once in the carousel. */
  get #perView() {
    return Math.max(1, Number.parseInt(this.dataset.perPage || '1', 10));
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

  /** The container this element renders into, kept beside the fallback JSON. */
  get #inner() {
    let inner = this.querySelector(':scope > .cart-upsell__inner');
    if (!inner) {
      inner = document.createElement('div');
      inner.className = 'cart-upsell__inner';
      this.append(inner);
    }
    return inner;
  }

  async #load() {
    const loadId = ++this.#loadId;
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

    // A newer load started while this one was waiting on the network.
    if (loadId !== this.#loadId) return;

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
    if (this.#fallback) return this.#fallback;

    const script = this.querySelector('[data-upsell-fallback]');
    try {
      const parsed = JSON.parse(script?.textContent || '[]');
      this.#fallback = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.#fallback = [];
    }
    return this.#fallback;
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

  /**
   * Percentage off shown on recommended products. This is display only: the
   * price is actually reduced by an automatic discount set up in the admin.
   */
  get #discountPercent() {
    const percent = Number.parseInt(this.dataset.discountPercent || '0', 10);
    return Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
  }

  /** Product ids the discount applies to; empty means every recommended product. */
  get #discountIds() {
    return new Set(
      (this.dataset.discountProducts || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    );
  }

  /** Whether the cart offer covers this product (an empty list covers every product). */
  #isEligible(product) {
    const ids = this.#discountIds;
    return ids.size === 0 || ids.has(String(product.id));
  }

  /** @param {Object} product */
  #isDiscounted(product) {
    return this.#discountPercent > 0 && this.#isEligible(product);
  }

  /**
   * @param {number} price - Variant price in minor units
   * @param {Object} product
   */
  #priceHtml(price, product) {
    if (this.#isDiscounted(product)) {
      const discounted = Math.round((price * (100 - this.#discountPercent)) / 100);
      return `
        <span class="cart-upsell__sale" data-upsell-price>${this.#money(discounted)}</span>
        <s class="cart-upsell__compare">${this.#money(price)}</s>
      `;
    }

    const onSale = product.compare_at_price && product.compare_at_price > price;
    return `
      <span data-upsell-price>${this.#money(price)}</span>
      ${onSale ? `<s class="cart-upsell__compare">${this.#money(product.compare_at_price)}</s>` : ''}
    `;
  }

  #render() {
    // Nothing to recommend: remove the content so the element collapses.
    if (!this.#products.length) {
      this.querySelector(':scope > .cart-upsell__inner')?.remove();
      return;
    }

    if (!this.querySelector('[data-upsell-list]')) this.#renderShell();
    this.#renderItems();
  }

  /** Builds the heading and the swipeable track once; only the track's items re-render. */
  #renderShell() {
    this.#inner.innerHTML = `
      <h3 class="cart-upsell__heading">${this.#escape(this.dataset.heading || '')}</h3>
      <ul class="cart-upsell__list" role="list" data-upsell-list></ul>
    `;
  }

  #renderItems() {
    const list = this.querySelector('[data-upsell-list]');
    if (!(list instanceof HTMLElement)) return;

    list.style.setProperty('--cart-upsell-per-view', String(this.#perView));
    list.innerHTML = this.#products.map((product) => this.#card(product)).join('');
    list.scrollLeft = 0;

    this.#bindCards();
  }

  /** @param {Object} product */
  #card(product) {
    const variants = Array.isArray(product.variants) ? product.variants.filter((v) => v.available) : [];
    const variant = variants[0];
    if (!variant) return '';

    const url = this.#escape(product.url || `/products/${product.handle}`);
    const image = this.#imageUrl(product.featured_image || product.images?.[0] || null, 200);
    const badge = this.#isDiscounted(product)
      ? `<span class="cart-upsell__badge">${this.#escape(this.dataset.discountLabel || 'Save')} ${this.#discountPercent}%</span>`
      : '';

    const variantSelect =
      variants.length > 1
        ? `<select class="cart-upsell__select" data-upsell-variant hidden aria-label="${this.#escape(product.options?.[0] || 'Variant')}">
             ${variants
               .map((v) => `<option value="${v.id}" data-price="${v.price}">${this.#escape(v.title)}</option>`)
               .join('')}
           </select>`
        : '';

    return `
      <li class="cart-upsell__item" data-upsell-card data-product-id="${product.id}">
        <a class="cart-upsell__media" href="${url}" tabindex="-1">
          ${
            image
              ? `<img class="cart-upsell__image" src="${image}" alt="${this.#escape(product.title)}" loading="lazy" width="64" height="64">`
              : '<span class="cart-upsell__image cart-upsell__image--empty"></span>'
          }
        </a>
        <div class="cart-upsell__info">
          ${badge}
          <a class="cart-upsell__title" href="${url}">${this.#escape(product.title)}</a>
          <p class="cart-upsell__price" data-upsell-price-block>${this.#priceHtml(variant.price, product)}</p>
          ${variantSelect}
        </div>
        <button type="button" class="${this.#escape(this.dataset.buttonClass || 'button')} cart-upsell__add" data-upsell-add data-variant-id="${variant.id}"${
          variants.length > 1 ? ' data-upsell-choose' : ''
        }>
          ${this.#escape(variants.length > 1 ? this.dataset.chooseLabel || 'Choose' : this.dataset.addLabel || 'Add')}
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

        const priceBlock = card.querySelector('[data-upsell-price-block]');
        const product = this.#products.find((item) => String(item.id) === card.getAttribute('data-product-id'));
        if (priceBlock && product) priceBlock.innerHTML = this.#priceHtml(Number(option.dataset.price), product);
      });
    });

    this.querySelectorAll('[data-upsell-add]').forEach((button) => {
      button.addEventListener('click', (event) => {
        if (button instanceof HTMLElement && button.hasAttribute('data-upsell-choose')) {
          this.#revealVariants(button);
        } else {
          this.#add(event);
        }
      });
    });
  }

  /**
   * First tap on "Choose": show the variant picker in the card and turn the
   * button into "Add". The button stays in place so the drawer remains open.
   * @param {HTMLElement} button
   */
  #revealVariants(button) {
    const select = button.closest('[data-upsell-card]')?.querySelector('[data-upsell-variant]');
    if (!(select instanceof HTMLSelectElement)) return;

    select.hidden = false;
    button.removeAttribute('data-upsell-choose');
    button.textContent = this.dataset.addLabel || 'Add';

    select.focus();
    try {
      select.showPicker?.();
    } catch {
      // Not supported everywhere (or not allowed); the visible, focused select is enough.
    }
  }

  /** @param {Event} event */
  async #add(event) {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;

    const variantId = button.dataset.variantId;
    if (!variantId || button.disabled) return;

    const card = button.closest('[data-upsell-card]');
    const productId = card instanceof HTMLElement ? card.dataset.productId : undefined;
    const product = this.#products.find((item) => String(item.id) === String(productId));

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

      // Drop it right away; the cart re-render then reloads fresh recommendations.
      this.#products = this.#products.filter((product) => String(product.id) !== String(productId));
      this.#render();

      let sections = result.sections;
      let cart = await fetch(`${Theme.routes.cart_url}.js`)
        .then((res) => (res.ok ? res.json() : undefined))
        .catch(() => undefined);

      // The offer is only for items added here, so the code is applied here and
      // never when the same product is added elsewhere on the site.
      const code = (this.dataset.discountCode || '').trim();
      if (code && product && this.#isEligible(product)) {
        const updated = await this.#applyDiscountCode(code, cart, sectionIds);
        if (updated) {
          cart = updated;
          sections = updated.sections ?? sections;
        }
      }

      this.dispatchEvent(
        new CartAddEvent(cart ?? {}, this.id || 'cart-upsell', {
          source: 'cart-upsell',
          itemCount: 1,
          productId,
          variantId,
          sections,
        })
      );
    } catch (error) {
      console.error('Cart upsell add failed:', error);
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  /**
   * Adds the cart offer code to the cart, keeping codes already applied.
   * If Shopify reports it as not applicable, the previous codes are restored so
   * the cart doesn't show a code that does nothing.
   * @param {string} code
   * @param {{ discount_codes?: Array<{ code: string }> } | undefined} cart
   * @param {Array<string | null | undefined>} sectionIds
   * @returns {Promise<(Object & { sections?: Record<string, string> }) | null>} The updated cart, or null if unchanged
   */
  async #applyDiscountCode(code, cart, sectionIds) {
    const existing = (cart?.discount_codes || []).map((discount) => discount.code).filter(Boolean);
    if (existing.some((existingCode) => existingCode.toLowerCase() === code.toLowerCase())) return null;

    /** @param {Array<string>} codes */
    const updateCodes = async (codes) => {
      const response = await fetch(Theme.routes.cart_update_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ discount: codes.join(','), sections: sectionIds.filter(Boolean) }),
      });
      if (!response.ok) throw new Error(`Discount update failed (${response.status})`);
      return response.json();
    };

    try {
      const updated = await updateCodes([...existing, code]);
      const rejected = (updated.discount_codes || []).some(
        (/** @type {{ code: string; applicable: boolean }} */ discount) =>
          discount.code.toLowerCase() === code.toLowerCase() && discount.applicable === false
      );
      if (!rejected) return updated;

      console.warn(`Cart upsell: discount code "${code}" does not apply to this cart; check its settings.`);
      return await updateCodes(existing);
    } catch (error) {
      console.error('Cart upsell: could not apply discount code:', error);
      return null;
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
