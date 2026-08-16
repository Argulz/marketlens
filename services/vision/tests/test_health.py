def test_health_repond_ok(client):
    reponse = client.get("/health")
    assert reponse.status_code == 200
    assert reponse.json() == {"status": "ok", "service": "marketlens-vision"}


def test_health_ne_demande_pas_de_secret(client):
    assert client.get("/health").status_code == 200
