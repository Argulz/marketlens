/**
 * MarketLens — Catalogue Module
 * Interactive zones, cart management, payment
 */

window.catalogueModule = (() => {
    // ---- Cart State ----
    const cart = [];

    // ---- State ----
    let currentSelectedProduct = null;
    let currentSelectedZone = null;

    // ---- Render Interactive Zones ----
    function renderInteractiveZones(products, imageEl) {
        const wrapper = document.getElementById('catalogue-image-wrapper');

        // Remove old zones
        wrapper.querySelectorAll('.product-zone').forEach(z => z.remove());

        const imgW = imageEl.naturalWidth;
        const imgH = imageEl.naturalHeight;
        const displayW = imageEl.clientWidth;
        const displayH = imageEl.clientHeight;

        products.forEach((product, index) => {
            if (!product.price) return; // Skip products without price

            const zone = document.createElement('div');
            zone.className = 'product-zone';
            zone.dataset.index = index;

            // Convert normalized coords (0-1000) to percentage
            const left = ((product.x - product.width / 2) / 1000) * 100;
            const top = ((product.y - product.height / 2) / 1000) * 100;
            const width = (product.width / 1000) * 100;
            const height = (product.height / 1000) * 100;

            zone.style.left = `${Math.max(0, left)}%`;
            zone.style.top = `${Math.max(0, top)}%`;
            zone.style.width = `${Math.min(100 - left, width)}%`;
            zone.style.height = `${Math.min(100 - top, height)}%`;

            // Price tag
            const tag = document.createElement('span');
            tag.className = 'product-zone__tag';
            tag.textContent = `${product.label} — ${product.price} FCFA`;
            zone.appendChild(tag);

            // Add info button
            const infoBtn = document.createElement('button');
            infoBtn.className = 'product-zone__info-btn';
            infoBtn.innerHTML = 'ℹ️';
            infoBtn.title = "Voir la description";
            zone.appendChild(infoBtn);

            // Add glassmorphism description
            const glassDesc = document.createElement('div');
            glassDesc.className = 'product-zone__glass-desc';

            const descStr = product.description ? product.description : "Aucune description détaillée.";
            glassDesc.innerHTML = `
                <button class="product-zone__glass-close">✕</button>
                <h4>${product.label}</h4>
                <p>${descStr}</p>
            `;
            zone.appendChild(glassDesc);

            // Show description on info button click
            infoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close others
                document.querySelectorAll('.product-zone__glass-desc').forEach(d => {
                    if (d !== glassDesc) d.classList.remove('active');
                });
                glassDesc.classList.add('active');
            });

            // Hide description on close button click
            const closeBtn = glassDesc.querySelector('.product-zone__glass-close');
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                glassDesc.classList.remove('active');
            });

            // Prevent cart add when clicking inside the description text (to allow scrolling/selection)
            glassDesc.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            // Click to add/remove from cart
            zone.addEventListener('click', () => toggleCartItem(product, zone));

            wrapper.appendChild(zone);
        });

        updateCartUI();
    }

    // ---- Toggle Cart Item ----
    function toggleCartItem(product, zoneEl) {
        const existingIndex = cart.findIndex(item => item.label === product.label);

        if (existingIndex >= 0) {
            cart.splice(existingIndex, 1);
            zoneEl.classList.remove('in-cart');
            showToast(`🗑️ ${product.label} retiré du panier`);
        } else {
            cart.push({
                label: product.label,
                price: parseFloat(product.price) || 0,
                category: product.category,
            });
            zoneEl.classList.add('in-cart');
            showToast(`🛒 ${product.label} ajouté au panier`);
        }

        updateCartUI();
    }

    // ---- Update Cart UI ----
    function updateCartUI() {
        const cartContainer = document.getElementById('cart');
        const cartItems = document.getElementById('cart-items');
        const cartBadge = document.getElementById('cart-badge');
        const cartTotal = document.getElementById('cart-total-amount');
        const btnPay = document.getElementById('btn-pay');

        if (cart.length === 0) {
            cartContainer.style.display = 'none';
            return;
        }

        cartContainer.style.display = 'block';
        cartBadge.textContent = cart.length;

        cartItems.innerHTML = '';
        let total = 0;

        cart.forEach((item, index) => {
            total += item.price;

            const li = document.createElement('li');
            li.className = 'cart__item';
            li.innerHTML = `
                <span class="cart__item-name">${item.label}</span>
                <span class="cart__item-price">${item.price.toLocaleString()} FCFA</span>
                <button class="cart__item-remove" data-index="${index}" title="Retirer">✕</button>
            `;
            cartItems.appendChild(li);
        });

        // Remove button handlers
        cartItems.querySelectorAll('.cart__item-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index);
                const removed = cart.splice(idx, 1)[0];
                // Remove in-cart class from zone
                document.querySelectorAll('.product-zone').forEach(z => {
                    const tag = z.querySelector('.product-zone__tag');
                    if (tag && tag.textContent.includes(removed.label)) {
                        z.classList.remove('in-cart');
                    }
                });
                updateCartUI();
                showToast(`🗑️ ${removed.label} retiré du panier`);
            });
        });

        cartTotal.textContent = `${total.toLocaleString()} FCFA`;
        btnPay.disabled = cart.length === 0;
    }

    // ---- Payment Flow ----
    function initPayment() {
        const modal = document.getElementById('payment-modal');
        modal.classList.add('active');
    }

    async function processPayment() {
        const phoneInput = document.getElementById('payer-phone');
        const phone = phoneInput.value.trim();
        const whatsappInput = document.getElementById('payer-whatsapp');
        const whatsapp = whatsappInput ? whatsappInput.value.trim() : '';

        if (!phone || phone.length < 8) {
            showToast('⚠️ Entrez un numéro de téléphone valide');
            return;
        }

        const total = cart.reduce((sum, item) => sum + item.price, 0);
        const merchantPhone = document.getElementById('merchant-phone-input')?.value || '229000000';
        const catalogueId = window.appState ? window.appState.catalogueId : '';

        const formData = new FormData();
        formData.append('payer_msisdn', phone);
        formData.append('payer_whatsapp', whatsapp);
        formData.append('payee_msisdn', merchantPhone);
        formData.append('amount', total.toString());
        formData.append('catalogue_id', catalogueId);
        formData.append('items_json', JSON.stringify(cart));

        try {
            const response = await fetch('/api/pay', {
                method: 'POST',
                body: formData,
            });

            const data = await response.json();

            if (data.success) {
                showPaymentSuccess(data);
            } else {
                showToast('❌ Échec du paiement');
            }
        } catch (error) {
            console.error('Payment error:', error);
            showToast(`❌ Erreur: ${error.message}`);
        }
    }

    function showPaymentSuccess(data) {
        const modal = document.getElementById('payment-modal');
        const modalContent = modal.querySelector('.modal');
        const transfer = data.transfer;

        let receiptHTML = '';
        if (data.receipt_id) {
            receiptHTML = `<a href="/api/receipt/${data.receipt_id}" target="_blank" class="btn-secondary" style="margin-top:10px; text-decoration:none; display:block; text-align:center;">📄 Télécharger la facture</a>`;
        }

        modalContent.innerHTML = `
            <div class="success-check">
                <span class="success-check__icon">✓</span>
            </div>
            <h3 class="modal__title">Paiement réussi !</h3>
            <p class="modal__message">
                Transfert de <strong>${parseInt(transfer.amount).toLocaleString()} ${transfer.currency}</strong>
                effectué avec succès.
                <br><br>
                <small style="color: var(--text-muted);">ID: ${transfer.transferId}</small>
                ${transfer.note ? `<br><small style="color: var(--gold);">${transfer.note}</small>` : ''}
            </p>
            ${receiptHTML}
            <button class="btn-primary" onclick="window.catalogueModule.closeModal(); location.reload();" style="margin-top:16px;">
                Terminer
            </button>
        `;
    }

    function closeModal() {
        const modal = document.getElementById('payment-modal');
        modal.classList.remove('active');
    }

    // ---- Toast (use global if available) ----
    function showToast(msg) {
        if (window.showToast) {
            window.showToast(msg);
        } else {
            // Fallback: create simple toast
            let toast = document.getElementById('toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'toast';
                toast.className = 'toast';
                document.body.appendChild(toast);
            }
            toast.textContent = msg;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3000);
        }
    }

    // ---- Init ----
    document.addEventListener('DOMContentLoaded', () => {
        const btnPay = document.getElementById('btn-pay');
        if (btnPay) {
            btnPay.addEventListener('click', initPayment);
        }

        const btnConfirmPay = document.getElementById('btn-confirm-pay');
        if (btnConfirmPay) {
            btnConfirmPay.addEventListener('click', processPayment);
        }

        const btnCloseModal = document.getElementById('btn-close-modal');
        if (btnCloseModal) {
            btnCloseModal.addEventListener('click', closeModal);
        }
    });

    // ---- Public API ----
    return {
        renderInteractiveZones,
        closeModal,
    };
})();

// Expose showToast globally so catalogue module can use it
window.showToast = window.showToast || function (msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
};
