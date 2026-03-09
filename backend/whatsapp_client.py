import os
import httpx
import logging

logger = logging.getLogger(__name__)

class WhatsAppClient:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=15.0)

    def _get_url(self) -> str:
        phone_id = os.getenv("WHATSAPP_PHONE_ID", "")
        return f"https://graph.facebook.com/v19.0/{phone_id}/messages"

    def _get_headers(self) -> dict:
        token = os.getenv("WHATSAPP_TOKEN", "")
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }

    async def send_text_message(self, to_phone: str, message: str) -> bool:
        """
        Envoie un message texte simple via l'API WhatsApp Cloud.
        """
        # Nettoyage basique du numéro (enlever les + et espaces)
        clean_phone = "".join(filter(str.isdigit, to_phone))
        
        # WhatsApp API requiert l'indicatif pays sans le + (ex: 33612345678 ou 22990000000)
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": clean_phone,
            "type": "text",
            "text": {
                "preview_url": True,
                "body": message
            }
        }
        
        try:
            response = await self.client.post(
                self._get_url(), 
                headers=self._get_headers(),
                json=payload
            )
            response.raise_for_status()
            logger.info(f"Message WhatsApp envoyé avec succès à {clean_phone}")
            return True
        except httpx.HTTPStatusError as e:
            logger.error(f"Erreur HTTP HTTPStatusError WhatsApp à {clean_phone}: {e.response.text}")
            return False
        except Exception as e:
            logger.error(f"Erreur d'envoi WhatsApp à {clean_phone}: {e}")
            return False

    async def send_template_message(self, to_phone: str, template_name: str = "hello_world") -> bool:
        """
        Envoie un message via un template approuvé (obligatoire en test sandbox si pas d'opt-in récent).
        """
        clean_phone = "".join(filter(str.isdigit, to_phone))
        
        payload = {
            "messaging_product": "whatsapp",
            "to": clean_phone,
            "type": "template",
            "template": {
                "name": template_name,
                "language": {
                    "code": "en_US"
                }
            }
        }
        
        try:
            response = await self.client.post(
                self._get_url(), 
                headers=self._get_headers(),
                json=payload
            )
            response.raise_for_status()
            logger.info(f"Template '{template_name}' envoyé avec succès à {clean_phone}")
            return True
        except httpx.HTTPStatusError as e:
            logger.error(f"Erreur HTTP HTTPStatusError WhatsApp (Template) à {clean_phone}: {e.response.text}")
            return False
        except Exception as e:
            logger.error(f"Erreur d'envoi WhatsApp (Template) à {clean_phone}: {e}")
            return False

    async def send_catalogue_link(self, vendor_phone: str, catalogue_url: str):
        """Envoie le lien du catalogue nouvellement créé au vendeur."""
        # En mode sandbox, on doit d'abord envoyer un template approuvé pour ouvrir la fenêtre de 24h
        await self.send_template_message(vendor_phone, "hello_world")
        
        msg = (
            "🎉 *Votre catalogue MarketLens est prêt !*\n\n"
            "Voici le lien à partager à vos clients pour qu'ils puissent commander directement :\n"
            f"👉 {catalogue_url}\n\n"
            "Bonnes ventes !"
        )
        await self.send_text_message(vendor_phone, msg)
        
    async def send_order_notification_to_vendor(self, vendor_phone: str, customer_phone: str, customer_whatsapp: str, items: list, total: float):
        """Notifie le vendeur d'une nouvelle commande."""
        await self.send_template_message(vendor_phone, "hello_world")
        
        msg = f"🛒 *NOUVELLE COMMANDE REÇUE !*\n\n"
        msg += f"📱 *Contact Client (Mobile Money) :* {customer_phone}\n"
        if customer_whatsapp and customer_whatsapp != customer_phone:
            msg += f"💬 *Contact Client (WhatsApp) :* wa.me/{customer_whatsapp.lstrip('+')}\n"
        else:
            msg += f"💬 *Contact Client (WhatsApp) :* wa.me/{customer_phone.lstrip('+')}\n"
            
        msg += "\n*Détails de la commande :*\n"
        for item in items:
            label = item.get('label', 'Article')
            price = item.get('price', 0)
            color = item.get('color', '')
            size = item.get('size', '')
            
            variant_str = ""
            if color or size:
                v_parts = []
                if color: v_parts.append(f"🎨 {color}")
                if size: v_parts.append(f"📐 {size}")
                variant_str = f" ({' | '.join(v_parts)})"
                
            msg += f"- {label}{variant_str} : {price} FCFA\n"
            
        msg += f"\n💰 *Total Payé :* {total} FCFA\n"
        msg += "\nPréparez les articles pour votre client ! 📦"
        
        await self.send_text_message(vendor_phone, msg)

    async def send_receipt_to_customer(self, customer_whatsapp: str, receipt_url: str, vendor_name: str):
        """Envoie le reçu d'achat au client."""
        await self.send_template_message(customer_whatsapp, "hello_world")
        
        msg = (
            f"✅ *Paiement confirmé chez {vendor_name} !*\n\n"
            "Merci pour votre achat. Vous pouvez télécharger votre facture PDF officielle via le lien ci-dessous :\n"
            f"📄 {receipt_url}\n\n"
            "À bientôt !"
        )
        await self.send_text_message(customer_whatsapp, msg)

    async def close(self):
        await self.client.aclose()

# Instance globale (singleton style)
whatsapp_client = WhatsAppClient()
