import os
import uuid
import time
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

RECEIPTS_DIR = os.path.join(os.path.dirname(__file__), "receipts")
os.makedirs(RECEIPTS_DIR, exist_ok=True)

def generate_receipt(
    merchant_name: str,
    merchant_phone: str,
    payer_phone: str,
    amount: float,
    items: list[dict],
    transfer_id: str
) -> str:
    """
    Génère un reçu PDF et retourne le chemin d'accès.
    """
    receipt_id = str(uuid.uuid4())
    filepath = os.path.join(RECEIPTS_DIR, f"{receipt_id}.pdf")
    
    doc = SimpleDocTemplate(filepath, pagesize=A4, rightMargin=30, leftMargin=30, topMargin=30, bottomMargin=18)
    elements = []
    
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle('TitleStyle', parent=styles['Heading1'], alignment=1, spaceAfter=20)
    normal_style = styles['Normal']
    
    # 1. Header
    elements.append(Paragraph("Facture MarketLens", title_style))
    elements.append(Paragraph(f"<b>Marchand :</b> {merchant_name}", normal_style))
    elements.append(Paragraph(f"<b>Contact Marchand :</b> {merchant_phone}", normal_style))
    elements.append(Paragraph(f"<b>Contact Client :</b> {payer_phone}", normal_style))
    elements.append(Paragraph(f"<b>ID Transfert :</b> {transfer_id}", normal_style))
    elements.append(Paragraph(f"<b>Date :</b> {time.strftime('%Y-%m-%d %H:%M:%S')}", normal_style))
    elements.append(Spacer(1, 20))
    
    # 2. Table of items
    data = [['Article', 'Prix (FCFA)']]
    for item in items:
        # Avoid missing label/price errors
        label = item.get("label", "Article Inconnu")
        color = item.get("color", "")
        size = item.get("size", "")
        
        variant_parts = []
        if color: variant_parts.append(color)
        if size: variant_parts.append(size)
        if variant_parts:
            label += f" ({', '.join(variant_parts)})"
            
        price = str(item.get("price", 0))
        data.append([label, price])
        
    data.append(['Total', str(amount)])
    
    t = Table(data, colWidths=[400, 100])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#052e16')), # Var(--forest) equivalent
        ('TEXTCOLOR', (0,0), (-1,0), colors.whitesmoke),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('ALIGN', (1,0), (1,-1), 'RIGHT'),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('BOTTOMPADDING', (0,0), (-1,0), 12),
        ('BACKGROUND', (0,-1), (-1,-1), colors.lightgrey),
        ('FONTNAME', (0,-1), (-1,-1), 'Helvetica-Bold'),
        ('GRID', (0,0), (-1,-1), 1, colors.black),
    ]))
    
    elements.append(t)
    elements.append(Spacer(1, 30))
    
    # Footer
    elements.append(Paragraph("Merci pour votre achat via le réseau MarketLens & Mojaloop !", styles['Italic']))
    
    doc.build(elements)
    
    return receipt_id

def get_receipt_path(receipt_id: str) -> str | None:
    path = os.path.join(RECEIPTS_DIR, f"{receipt_id}.pdf")
    if os.path.exists(path):
        return path
    return None
