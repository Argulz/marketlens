"""L'OpenAPI est le contrat que trois plans successifs vont consommer.

Il fige à la fusion : ce qu'il décrit doit être ce que les routes rendent.
"""


def test_annotate_declare_produire_du_jpeg(client):
    schema = client.get("/openapi.json").json()
    contenu = schema["paths"]["/annotate"]["post"]["responses"]["200"]["content"]
    assert "image/jpeg" in contenu
    assert "application/json" not in contenu


def test_detect_decrit_la_forme_de_sa_reponse(client):
    schema = client.get("/openapi.json").json()
    reponse = schema["paths"]["/detect"]["post"]["responses"]["200"]
    ref = reponse["content"]["application/json"]["schema"]["$ref"]
    assert ref.endswith("DetectResponse")

    detect = schema["components"]["schemas"]["DetectResponse"]
    assert set(detect["properties"]) == {"products", "count"}

    produit = schema["components"]["schemas"]["ProductOut"]
    assert set(produit["properties"]) == {
        "label", "x", "y", "width", "height", "category",
    }
