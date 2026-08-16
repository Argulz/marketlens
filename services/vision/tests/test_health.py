def test_health_repond_ok_sans_secret(client):
    """Aucun en-tête X-Vision-Secret : /health reste ouvert."""
    reponse = client.get("/health")
    assert reponse.status_code == 200
    assert reponse.json() == {"status": "ok", "service": "marketlens-vision"}
