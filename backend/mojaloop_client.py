"""
MarketLens — Client Mojaloop simplifié
Gère les lookups de participants et l'initiation de transferts P2P.
"""

import uuid
import logging
from datetime import datetime, timezone

import httpx

logger = logging.getLogger(__name__)


class MojaloopClient:
    """Client pour interagir avec l'API Mojaloop."""
    
    def __init__(self, base_url: str, currency: str = "XOF"):
        self.base_url = base_url.rstrip("/")
        self.currency = currency
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=30.0,
            headers={
                "Content-Type": "application/vnd.interoperability.transfers+json;version=1.1",
                "Accept": "application/vnd.interoperability.transfers+json;version=1.1",
                "Date": datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT"),
            },
        )
    
    async def lookup_participant(self, msisdn: str) -> dict:
        """
        Cherche un participant par son numéro MSISDN.
        
        Args:
            msisdn: Numéro de téléphone (ex: "254700000000")
            
        Returns:
            Informations du participant
        """
        try:
            response = await self.client.get(
                f"/parties/MSISDN/{msisdn}",
                headers={
                    "Accept": "application/vnd.interoperability.parties+json;version=1.1",
                    "Content-Type": "application/vnd.interoperability.parties+json;version=1.1",
                },
            )
            response.raise_for_status()
            data = response.json()
            logger.info(f"Participant trouvé: {msisdn}")
            return data
        except httpx.HTTPStatusError as e:
            logger.error(f"Erreur lookup participant {msisdn}: {e.response.status_code}")
            raise
        except httpx.RequestError as e:
            logger.warning(f"Mojaloop non disponible pour lookup: {e}")
            # Mode démo : retourner un participant simulé
            return {
                "party": {
                    "partyIdInfo": {
                        "partyIdType": "MSISDN",
                        "partyIdentifier": msisdn,
                    },
                    "name": f"Marchand {msisdn[-4:]}",
                    "personalInfo": {
                        "complexName": {
                            "firstName": "Marchand",
                            "lastName": msisdn[-4:],
                        }
                    }
                }
            }
    
    async def initiate_transfer(
        self,
        payer_msisdn: str,
        payee_msisdn: str,
        amount: str,
        currency: str | None = None,
    ) -> dict:
        """
        Initie un transfert P2P via Mojaloop.
        
        Args:
            payer_msisdn: MSISDN du payeur
            payee_msisdn: MSISDN du bénéficiaire (marchand)
            amount: Montant en string (ex: "1500")
            currency: Devise (défaut: XOF)
            
        Returns:
            Résultat du transfert
        """
        transfer_id = str(uuid.uuid4())
        currency = currency or self.currency
        
        # Mode démo : simuler toujours un transfert réussi
        logger.info(f"Transfert simulé: {transfer_id} — {amount} {currency}")
        return {
            "transferId": transfer_id,
            "status": "COMPLETED_DEMO",
            "amount": amount,
            "currency": currency,
            "payer": payer_msisdn,
            "payee": payee_msisdn,
            "note": "Transfert simulé — Succès forcé",
        }
    
    async def close(self):
        """Ferme le client HTTP."""
        await self.client.aclose()
