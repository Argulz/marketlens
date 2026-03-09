# Guide Complet : Déployer MarketLens sur un VPS

Ce guide est adapté de votre précédent déploiement (TTS). Au lieu de transférer les fichiers manuellement, nous utiliserons **Git** pour cloner le projet directement depuis GitHub.

## 📋 Prérequis

- ✅ Adresse IP du VPS (ex: `45.123.45.67`)
- ✅ Nom d'utilisateur (`root` ou autre utilisateur avec droits sudo)
- ✅ Mot de passe ou clé SSH

---

## 🚀 Étape 1 : Connexion au VPS

Connectez-vous à votre VPS via SSH (PuTTY ou terminal) :
```bash
ssh root@VOTRE_IP_VPS
```

---

## 🔧 Étape 2 : Mettre à jour et installer les outils

```bash
# Mettre à jour le système
apt update && apt upgrade -y

# Installer Python 3.12, venv, pip et Git
apt install -y software-properties-common
add-apt-repository ppa:deadsnakes/ppa -y
apt update
apt install -y python3.12 python3.12-venv python3.12-dev python3-pip git
```

---

## 📁 Étape 3 : Cloner le projet depuis GitHub (Nouveau)

Au lieu de transférer les fichiers via WinSCP, récupérez le code source directement depuis GitHub :

```bash
# Créer le répertoire parent
mkdir -p /opt
cd /opt

# Cloner le dépôt GitHub (Assurez-vous que le dépôt est public ou configurez un token)
git clone https://github.com/Argulz/marketlens.git

# Entrer dans le dossier du projet
cd marketlens
```

---

## 🌐 Étape 4 : Configurer l'environnement Python

```bash
cd /opt/marketlens

# Créer un environnement virtuel
python3.12 -m venv venv

# Activer l'environnement
source venv/bin/activate

# Mettre à jour pip et installer les dépendances du backend
pip install --upgrade pip
pip install -r backend/requirements.txt
```

---

## ⚙️ Étape 5 : Configurer les Variables d'Environnement

```bash
# Copier le fichier d'exemple s'il existe, sinon créer un nouveau fichier .env
cp backend/.env.example backend/.env
nano backend/.env
```
Ajoutez/modifiez vos clés API dans le fichier (ex: `GEMINI_API_KEY`). Sauvegardez avec `Ctrl+O`, `Entrée`, `Ctrl+X`.

---

## 🧪 Étape 6 : Test rapide

```bash
# Lancer le serveur avec Uvicorn
uvicorn backend.app:app --host 0.0.0.0 --port 8000
```
- Vérifiez qu'il n'y a pas d'erreur au démarrage.
- Arrêtez avec `Ctrl+C`.

---

## 🔥 Étape 7 : Pare-feu (UFW)

```bash
# Autoriser le port SSH et le port 8000
ufw allow 22/tcp
ufw allow 8000/tcp
ufw enable
```

---

## 🔄 Étape 8 : Configurer Systemd (Lancement automatique)

1. **Créer le fichier de service** :
```bash
nano /etc/systemd/system/marketlens.service
```

2. **Copier cette configuration** :
```ini
[Unit]
Description=MarketLens API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/marketlens
Environment="PATH=/opt/marketlens/venv/bin"
# Lancement de l'application via uvicorn
ExecStart=/opt/marketlens/venv/bin/uvicorn backend.app:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
*(Note: on écoute sur `127.0.0.1` si Nginx sera configuré en reverse proxy).*

3. **Activer le service** :
```bash
systemctl daemon-reload
systemctl start marketlens
systemctl enable marketlens
systemctl status marketlens
```

---

## 🌐 Étape 9 : Configuration Nginx (Optionnel mais recommandé pour la prod)

```bash
apt install -y nginx
nano /etc/nginx/sites-available/marketlens
```

**Configuration :**
```nginx
server {
    listen 80;
    server_name VOTRE_NOM_DE_DOMAINE_OU_IP;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**Activer et recharger Nginx :**
```bash
ln -s /etc/nginx/sites-available/marketlens /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

---

## 🎉 C'est prêt !

Votre API MarketLens est désormais accessible sur `http://VOTRE_IP/docs` (ou port 8000 si pas de Nginx).
