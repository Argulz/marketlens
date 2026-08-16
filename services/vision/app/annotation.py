"""
MarketLens — Module d'annotation d'images
Superpose des étiquettes de prix sur l'image aux coordonnées Gemini.
"""

import io
import logging
from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger(__name__)

# Couleurs par catégorie (R, G, B, A)
CATEGORY_COLORS = {
    "fruits_legumes": (34, 139, 34, 200),    # Vert forêt
    "viande_poisson": (178, 34, 34, 200),     # Rouge brique
    "cereales": (184, 134, 11, 200),          # Or foncé
    "boissons": (30, 144, 255, 200),          # Bleu dodger
    "textile": (148, 103, 189, 200),          # Violet
    "electronique": (44, 62, 80, 200),        # Bleu marine
    "autre": (127, 127, 127, 200),            # Gris
}

# Couleur de fallback
DEFAULT_COLOR = (52, 73, 94, 200)


def annotate_image(
    image_bytes: bytes,
    products: list[dict],
    max_width: int = 1200,
) -> bytes:
    """
    Annote une image avec des étiquettes de prix aux coordonnées des produits.
    
    Args:
        image_bytes: Image source en bytes
        products: Liste de produits avec label, x, y, width, height, category, price
        max_width: Largeur max de sortie (pour optimisation WhatsApp)
        
    Returns:
        Image annotée en bytes JPEG
    """
    img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    
    # Redimensionner si nécessaire
    if img.width > max_width:
        ratio = max_width / img.width
        new_height = int(img.height * ratio)
        img = img.resize((max_width, new_height), Image.LANCZOS)
    
    # Créer un overlay transparent pour les annotations
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    
    # Charger une police (fallback sur la police par défaut)
    font_large = _get_font(22)
    font_small = _get_font(14)
    
    img_w, img_h = img.size
    
    for product in products:
        label = product.get("label", "Produit")
        price = product.get("price", "")
        category = product.get("category", "autre")
        
        # Convertir les coordonnées normalisées (0-1000) en pixels
        cx = int(product["x"] / 1000 * img_w)
        cy = int(product["y"] / 1000 * img_h)
        pw = int(product["width"] / 1000 * img_w)
        ph = int(product["height"] / 1000 * img_h)
        
        color = CATEGORY_COLORS.get(category, DEFAULT_COLOR)
        
        # Dessiner le contour du produit (rectangle en pointillés)
        x1 = cx - pw // 2
        y1 = cy - ph // 2
        x2 = cx + pw // 2
        y2 = cy + ph // 2
        
        _draw_dashed_rect(draw, x1, y1, x2, y2, color[:3], width=2)
        
        # Préparer le texte de l'étiquette
        if price:
            price_text = f"{price} FCFA"
            label_text = label
        else:
            price_text = ""
            label_text = label
        
        # Calculer la taille du badge
        badge_texts = [label_text]
        if price_text:
            badge_texts.append(price_text)
        
        max_text_w = 0
        total_text_h = 0
        for i, txt in enumerate(badge_texts):
            font = font_large if i == 1 else font_small
            bbox = draw.textbbox((0, 0), txt, font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            max_text_w = max(max_text_w, tw)
            total_text_h += th + 4
        
        padding = 8
        badge_w = max_text_w + padding * 2
        badge_h = total_text_h + padding * 2
        
        # Positionner le badge au-dessus du produit
        badge_x = cx - badge_w // 2
        badge_y = y1 - badge_h - 6
        
        # S'assurer que le badge reste dans l'image
        badge_x = max(4, min(img_w - badge_w - 4, badge_x))
        badge_y = max(4, min(img_h - badge_h - 4, badge_y))
        
        # Dessiner le badge avec coins arrondis
        _draw_rounded_rect(
            draw,
            badge_x, badge_y,
            badge_x + badge_w, badge_y + badge_h,
            radius=10,
            fill=color,
        )
        
        # Dessiner le texte
        text_y = badge_y + padding
        for i, txt in enumerate(badge_texts):
            font = font_large if i == 1 else font_small
            text_color = (255, 255, 255, 255)
            bbox = draw.textbbox((0, 0), txt, font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            text_x = badge_x + (badge_w - tw) // 2
            draw.text((text_x, text_y), txt, fill=text_color, font=font)
            text_y += th + 4
    
    # Combiner l'original avec l'overlay
    result = Image.alpha_composite(img, overlay)
    result = result.convert("RGB")
    
    # Exporter en JPEG
    output = io.BytesIO()
    result.save(output, format="JPEG", quality=85, optimize=True)
    output.seek(0)
    
    logger.info(f"Image annotée générée: {img_w}x{img_h}, {len(products)} produits")
    return output.read()


def _get_font(size: int):
    """Essaie de charger une police TrueType, sinon utilise la police par défaut."""
    font_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
    ]
    for path in font_paths:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def _draw_rounded_rect(draw, x1, y1, x2, y2, radius, fill):
    """Dessine un rectangle aux coins arrondis."""
    draw.rounded_rectangle(
        [(x1, y1), (x2, y2)],
        radius=radius,
        fill=fill,
    )


def _draw_dashed_rect(draw, x1, y1, x2, y2, color, width=2, dash_length=8):
    """Dessine un rectangle en pointillés."""
    edges = [
        ((x1, y1), (x2, y1)),  # haut
        ((x2, y1), (x2, y2)),  # droite
        ((x2, y2), (x1, y2)),  # bas
        ((x1, y2), (x1, y1)),  # gauche
    ]
    for (sx, sy), (ex, ey) in edges:
        _draw_dashed_line(draw, sx, sy, ex, ey, color, width, dash_length)


def _draw_dashed_line(draw, x1, y1, x2, y2, color, width, dash_length):
    """Dessine une ligne en pointillés."""
    import math
    dx = x2 - x1
    dy = y2 - y1
    length = math.sqrt(dx * dx + dy * dy)
    if length == 0:
        return
    dx /= length
    dy /= length
    
    pos = 0
    drawing = True
    while pos < length:
        end = min(pos + dash_length, length)
        if drawing:
            sx = int(x1 + dx * pos)
            sy = int(y1 + dy * pos)
            ex = int(x1 + dx * end)
            ey = int(y1 + dy * end)
            draw.line([(sx, sy), (ex, ey)], fill=color + (255,), width=width)
        pos = end
        drawing = not drawing
