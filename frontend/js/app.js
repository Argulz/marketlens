/**
 * MarketLens — Main SPA Logic
 * Navigation between views, image upload, API calls
 */

// ---- State ----
const state = {
    currentView: 'capture',
    imageFile: null,
    imagePreviewUrl: null,
    products: [],
    annotatedImageUrl: null,
};

// ---- Category Icons ----
const CATEGORY_ICONS = {
    fruits_legumes: '🥬',
    viande_poisson: '🐟',
    cereales: '🌾',
    boissons: '🥤',
    textile: '👕',
    electronique: '📱',
    autre: '📦',
};

// ---- View Navigation ----
function showView(viewName) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${viewName}`);
    if (target) {
        target.classList.add('active');
        state.currentView = viewName;
    }
}

// ---- Toast Notification ----
function showToast(message, duration = 3000) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
}

// ---- Image Upload Handling ----
function initUpload() {
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const cameraInput = document.getElementById('camera-input');
    const cameraBtn = document.getElementById('camera-btn');

    // Drag & drop
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('dragover');
    });

    uploadZone.addEventListener('dragleave', () => {
        uploadZone.classList.remove('dragover');
    });

    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
            handleImageSelected(file);
        }
    });

    // File input change
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleImageSelected(file);
    });

    // Camera button
    cameraBtn.addEventListener('click', () => {
        cameraInput.click();
    });

    cameraInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleImageSelected(file);
    });
}

function handleImageSelected(file) {
    state.imageFile = file;
    state.imagePreviewUrl = URL.createObjectURL(file);

    // Show preview
    const previewContainer = document.getElementById('preview-container');
    const previewImg = document.getElementById('preview-img');
    previewImg.src = state.imagePreviewUrl;
    previewContainer.classList.add('show');

    showToast('📸 Image chargée ! Lancement de l\'analyse...');

    // Auto-detect
    detectProducts();
}

// ---- API: Detect Products ----
async function detectProducts() {
    const loader = document.getElementById('loader');
    loader.classList.add('active');

    const formData = new FormData();
    formData.append('image', state.imageFile);

    try {
        const response = await fetch('/api/detect', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Erreur de détection');
        }

        const data = await response.json();
        state.products = data.products;

        loader.classList.remove('active');
        showToast(`✅ ${data.count} produit(s) détecté(s) !`);

        renderProductList();
        showView('edit');
    } catch (error) {
        loader.classList.remove('active');
        showToast(`❌ Erreur: ${error.message}`);
        console.error('Detection error:', error);
    }
}

// ---- Render Product List (Edit View) ----
function renderProductList() {
    const container = document.getElementById('product-list');
    const countEl = document.getElementById('product-count');

    countEl.textContent = state.products.length;
    container.innerHTML = '';

    state.products.forEach((product, index) => {
        const categoryLabel = product.category.replace('_', ' / ');

        // Calculer la zone de l'image pour la miniature
        const pw = (product.width / 1000) * 100;
        const ph = (product.height / 1000) * 100;

        const bgSizeX = pw > 0 ? (100 / pw) * 100 : 100;
        const bgSizeY = ph > 0 ? (100 / ph) * 100 : 100;

        const left = (product.x / 1000) * 100 - pw / 2;
        const top = (product.y / 1000) * 100 - ph / 2;

        const bgPosX = (100 - pw) > 0 ? (left / (100 - pw)) * 100 : 50;
        const bgPosY = (100 - ph) > 0 ? (top / (100 - ph)) * 100 : 50;

        const item = document.createElement('div');
        item.className = 'product-edit-item';
        item.innerHTML = `
            <div class="product-edit-item__header">
                <div class="product-edit-item__thumbnail" style="
                    background-image: url('${state.imagePreviewUrl}');
                    background-size: ${bgSizeX}% ${bgSizeY}%;
                    background-position: ${Math.max(0, Math.min(100, bgPosX))}% ${Math.max(0, Math.min(100, bgPosY))}%;
                "></div>
                <div class="product-edit-item__title-group">
                    <input type="text" class="product-edit-item__name-input" id="name-${index}" value="${product.label}" placeholder="Nom du produit" />
                    <div class="product-edit-item__category">${categoryLabel}</div>
                </div>
            </div>
            
            <textarea class="product-edit-item__desc-input" id="desc-${index}" placeholder="Description détaillée (optionnelle)"></textarea>
            
            <div class="product-edit-item__price-row">
                <input
                    type="number"
                    class="product-item__price-input"
                    id="price-${index}"
                    placeholder="Prix"
                    min="0"
                    step="50"
                    inputmode="numeric"
                />
                <span class="product-item__currency">FCFA</span>
            </div>

            <details class="tag-input-group">
                <summary>🎨 Couleurs / 📐 Tailles (optionnel)</summary>
                
                <div class="tag-input-row">
                    <span class="tag-input-row__label">🎨</span>
                    <input type="text" id="color-input-${index}" placeholder="Ex: Rouge" />
                    <button type="button" class="tag-input-row__add" data-type="color" data-index="${index}">+</button>
                </div>
                <div class="tag-chips" id="color-chips-${index}"></div>

                <div class="tag-input-row" style="margin-top:6px;">
                    <span class="tag-input-row__label">📐</span>
                    <input type="text" id="size-input-${index}" placeholder="Ex: M, L, 42" />
                    <button type="button" class="tag-input-row__add" data-type="size" data-index="${index}">+</button>
                </div>
                <div class="tag-chips" id="size-chips-${index}"></div>
            </details>
        `;
        container.appendChild(item);

        // Wire up tag-input events for this product
        wireTagInput(index, 'color');
        wireTagInput(index, 'size');
    });
}

// ---- Tag Input Logic ----
// Stores: { 0: { colors: ['Rouge', 'Bleu'], sizes: ['M', 'L'] }, ... }
const productVariants = {};

function wireTagInput(index, type) {
    const input = document.getElementById(`${type}-input-${index}`);
    const addBtn = document.querySelector(`.tag-input-row__add[data-type="${type}"][data-index="${index}"]`);

    function addTag() {
        const val = input.value.trim();
        if (!val) return;

        if (!productVariants[index]) productVariants[index] = { colors: [], sizes: [] };
        const arr = type === 'color' ? productVariants[index].colors : productVariants[index].sizes;

        // No duplicates (case-insensitive)
        if (arr.some(t => t.toLowerCase() === val.toLowerCase())) {
            input.value = '';
            return;
        }

        arr.push(val);
        input.value = '';
        renderChips(index, type);
    }

    addBtn.addEventListener('click', addTag);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addTag(); }
    });
}

function renderChips(index, type) {
    const container = document.getElementById(`${type}-chips-${index}`);
    const arr = type === 'color' ? productVariants[index].colors : productVariants[index].sizes;
    const chipClass = type === 'color' ? 'tag-chip--color' : 'tag-chip--size';

    container.innerHTML = '';
    arr.forEach((tag, i) => {
        const chip = document.createElement('span');
        chip.className = `tag-chip ${chipClass}`;
        chip.innerHTML = `${tag} <span class="tag-chip__remove" data-i="${i}">✕</span>`;
        chip.querySelector('.tag-chip__remove').addEventListener('click', () => {
            arr.splice(i, 1);
            renderChips(index, type);
        });
        container.appendChild(chip);
    });
}

// ---- Generate Annotated Catalogue ----
async function generateCatalogue() {
    // Collect edited names, descriptions, and prices
    const productsWithPrices = state.products.map((p, i) => {
        const nameInput = document.getElementById(`name-${i}`);
        const descInput = document.getElementById(`desc-${i}`);
        const priceInput = document.getElementById(`price-${i}`);
        const variants = productVariants[i] || { colors: [], sizes: [] };
        return {
            ...p,
            label: nameInput.value || p.label,
            description: descInput.value || '',
            price: priceInput.value || '',
            colors: variants.colors || [],
            sizes: variants.sizes || [],
        };
    });

    // Check that at least one price is set
    const hasPrices = productsWithPrices.some(p => p.price !== '');
    if (!hasPrices) {
        showToast('⚠️ Ajoutez au moins un prix avant de générer le catalogue');
        return;
    }

    const loader = document.getElementById('loader-catalogue');
    loader.classList.add('active');

    // Collect vendor info
    const merchantName = document.getElementById('merchant-name-input').value.trim() || 'Vendeur Inconnu';
    const merchantPhone = document.getElementById('merchant-phone-input').value.trim();
    const merchantWhatsapp = document.getElementById('merchant-whatsapp-input').value.trim();

    if (!merchantPhone) {
        loader.classList.remove('active');
        showToast('⚠️ Le numéro de téléphone du vendeur est obligatoire');
        return;
    }

    const formData = new FormData();
    formData.append('image', state.imageFile);
    formData.append('products', JSON.stringify(productsWithPrices));
    formData.append('merchant_name', merchantName);
    formData.append('merchant_phone', merchantPhone);
    formData.append('merchant_whatsapp', merchantWhatsapp);

    try {
        const response = await fetch('/api/annotate', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            throw new Error('Erreur de génération du catalogue');
        }

        // Récupérer l'ID du catalogue depuis le header
        const catalogueId = response.headers.get('X-Catalogue-Id');
        state.catalogueId = catalogueId;

        const blob = await response.blob();
        state.annotatedImageUrl = URL.createObjectURL(blob);
        state.annotatedBlob = blob;
        state.productsWithPrices = productsWithPrices;

        loader.classList.remove('active');

        // Construire le lien partageable
        if (catalogueId) {
            const shareUrl = `${window.location.origin}/c/${catalogueId}`;
            state.shareUrl = shareUrl;
            setupShareButtons(shareUrl, blob);
        }

        // Switch to catalogue view
        showCatalogue(productsWithPrices);
        showView('catalogue');
        showToast('🎨 Catalogue généré avec succès !');
    } catch (error) {
        loader.classList.remove('active');
        showToast(`❌ Erreur: ${error.message}`);
        console.error('Annotation error:', error);
    }
}

// ---- Show Catalogue ----
function showCatalogue(products) {
    const catalogueImg = document.getElementById('catalogue-img');
    catalogueImg.src = state.annotatedImageUrl;

    // Wait for image to load to calculate positions
    catalogueImg.onload = () => {
        window.catalogueModule.renderInteractiveZones(products, catalogueImg);
    };
}

// ---- Restart ----
function restart() {
    state.imageFile = null;
    state.imagePreviewUrl = null;
    state.products = [];
    state.annotatedImageUrl = null;

    // Reset UI
    document.getElementById('preview-container').classList.remove('show');
    document.getElementById('file-input').value = '';
    document.getElementById('camera-input').value = '';
    document.getElementById('product-list').innerHTML = '';

    showView('capture');
    showToast('🔄 Prêt pour une nouvelle analyse');
}

// ---- Sharing Functions ----
function setupShareButtons(shareUrl, blob) {
    const sharePanel = document.getElementById('share-panel');
    if (sharePanel) sharePanel.classList.remove('hidden');

    // Share URL display
    const shareUrlEl = document.getElementById('share-url');
    if (shareUrlEl) shareUrlEl.textContent = shareUrl;
}

function downloadCatalogue() {
    if (!state.annotatedBlob) return;
    const a = document.createElement('a');
    a.href = state.annotatedImageUrl;
    a.download = 'catalogue_marketlens.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('📥 Image téléchargée !');
}

function shareWhatsApp() {
    if (!state.shareUrl) return;
    const text = encodeURIComponent(
        `🛍️ Découvrez mes produits sur MarketLens !\n\n👉 ${state.shareUrl}\n\n💳 Achetez et payez directement via Mobile Money !`
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
}

function copyShareLink() {
    if (!state.shareUrl) return;
    navigator.clipboard.writeText(state.shareUrl).then(() => {
        showToast('📋 Lien copié !');
    }).catch(() => {
        // Fallback
        const input = document.createElement('input');
        input.value = state.shareUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showToast('📋 Lien copié !');
    });
}

async function nativeShare() {
    if (!navigator.share) {
        copyShareLink();
        return;
    }
    try {
        const shareData = {
            title: 'Mon catalogue MarketLens',
            text: '🛍️ Découvrez mes produits et payez via Mobile Money !',
            url: state.shareUrl,
        };
        await navigator.share(shareData);
    } catch (e) {
        if (e.name !== 'AbortError') copyShareLink();
    }
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
    window.appState = state; // Expose for catalogue.js
    initUpload();
    showView('capture');

    // Button bindings
    document.getElementById('btn-generate').addEventListener('click', generateCatalogue);
    document.getElementById('btn-restart-edit').addEventListener('click', restart);
    document.getElementById('btn-restart-catalogue').addEventListener('click', restart);

    // Share buttons
    document.getElementById('btn-download')?.addEventListener('click', downloadCatalogue);
    document.getElementById('btn-whatsapp')?.addEventListener('click', shareWhatsApp);
    document.getElementById('btn-copy-link')?.addEventListener('click', copyShareLink);
    document.getElementById('btn-native-share')?.addEventListener('click', nativeShare);
});
