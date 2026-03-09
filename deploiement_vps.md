# Guide Complet : Déployer l'API TTS sur VPS avec PuTTY

## 📋 Prérequis

**Informations dont vous avez besoin :**
- ✅ Adresse IP du VPS (ex: `45.123.45.67`)
- ✅ Nom d'utilisateur (généralement `root` ou `ubuntu`)
- ✅ Mot de passe ou clé SSH

## 🚀 Étape 1 : Connexion au VPS avec PuTTY

### 1.1 Installer PuTTY (si pas déjà fait)

Téléchargez depuis : https://www.putty.org/

### 1.2 Se connecter

1. **Ouvrir PuTTY**
2. Dans "Host Name (or IP address)" : `votre_ip_vps`
3. Port : `22`
4. Connection type : `SSH`
5. Cliquer **"Open"**

6. **Première connexion** :
   - Alert "Server's host key" → Cliquer **"Accept"**

7. **Login** :
   ```
   login as: root
   password: [tapez votre mot de passe - il ne s'affiche pas, c'est normal]
   ```

✅ Vous êtes connecté quand vous voyez :
```
root@votre-serveur:~#
```

---

## 🔧 Étape 2 : Mettre à jour le système

**Copiez-collez ces commandes une par une :**

```bash
# Mettre à jour la liste des paquets
apt update

# Mettre à jour le système
apt upgrade -y
```

⏱️ **Attendez** que chaque commande se termine (peut prendre 2-5 minutes).

---

## 🐍 Étape 3 : Installer Python 3.12 et outils

```bash
# Installer les dépendances système
apt install -y software-properties-common

# Ajouter le repository Python
add-apt-repository ppa:deadsnakes/ppa -y

# Mettre à jour
apt update

# Installer Python 3.12
apt install -y python3.12 python3.12-venv python3.12-dev

# Installer pip
apt install -y python3-pip

# Vérifier l'installation
python3.12 --version
```

✅ Vous devriez voir : `Python 3.12.x`

---

## 📦 Étape 4 : Installer les dépendances système pour TTS

```bash
# Dépendances pour audio et ML
apt install -y build-essential libsndfile1 ffmpeg git

# Dépendances pour transformers
apt install -y libgomp1
```

---

## 📁 Étape 5 : Créer le dossier de l'application

```bash
# Créer dossier
mkdir -p /opt/tts-api
cd /opt/tts-api

# Vérifier que vous êtes dans le bon dossier
pwd
```

✅ Doit afficher : `/opt/tts-api`

---

## 📤 Étape 6 : Transférer les fichiers depuis votre PC

### Option A : Utiliser WinSCP (Recommandé - Interface graphique)

1. **Télécharger WinSCP** : https://winscp.net/

2. **Se connecter** :
   - File protocol : `SFTP`
   - Host name : `votre_ip_vps`
   - Port : `22`
   - User name : `root`
   - Password : `votre_mot_de_passe`
   - Cliquer **"Login"**

3. **Transférer les fichiers** :
   - Fenêtre gauche : `C:\Projects\mojaloop\tts`
   - Fenêtre droite : `/opt/tts-api`
   - Glisser-déposer ces fichiers :
     - `api.py`
     - `requirements.txt`
     - `.env`
     - `mainfon.py` (optionnel)

### Option B : Utiliser PSCP (Ligne de commande Windows)

**Sur votre PC Windows** (PowerShell) :

```powershell
# Aller dans le dossier PuTTY
cd "C:\Program Files\PuTTY"

# Transférer api.py
.\pscp.exe C:\Projects\mojaloop\tts\api.py root@VOTRE_IP:/opt/tts-api/

# Transférer requirements.txt
.\pscp.exe C:\Projects\mojaloop\tts\requirements.txt root@VOTRE_IP:/opt/tts-api/

# Transférer .env
.\pscp.exe C:\Projects\mojaloop\tts\.env root@VOTRE_IP:/opt/tts-api/
```

---

## 🔑 Étape 7 : Vérifier les fichiers transférés

**Retour dans PuTTY** :

```bash
cd /opt/tts-api
ls -la
```

✅ Vous devriez voir :
```
api.py
requirements.txt
.env
```

---

## 🌐 Étape 8 : Créer l'environnement virtuel Python

```bash
cd /opt/tts-api

# Créer venv
python3.12 -m venv venv

# Activer venv
source venv/bin/activate
```

✅ Votre prompt change : `(venv) root@serveur:/opt/tts-api#`

---

## 📚 Étape 9 : Installer les packages Python

```bash
# Mettre à jour pip
pip install --upgrade pip

# Installer les dépendances
pip install -r requirements.txt
```

⏱️ **ATTENTION** : Cette étape prend **15-30 minutes** !
- Les modèles de transformers sont lourds (plusieurs GB)
- Soyez patient, ne fermez pas PuTTY

---

## 🧪 Étape 10 : Test rapide

```bash
# Test de l'API
python api.py
```

✅ Vous devriez voir :
```
🔄 Loading Fon TTS model...
✅ Fon TTS model loaded!
🔄 Loading French TTS model...
✅ French TTS model loaded!
...
INFO: Uvicorn running on http://0.0.0.0:8000
```

**Arrêter** : `Ctrl + C`

---

## 🔥 Étape 11 : Configurer le pare-feu

```bash
# Installer UFW (firewall)
apt install -y ufw

# Autoriser SSH (IMPORTANT !)
ufw allow 22/tcp

# Autoriser port 8000 (API)
ufw allow 8000/tcp

# Activer le firewall
ufw enable

# Vérifier
ufw status
```

✅ Devrait afficher :
```
8000/tcp    ALLOW       Anywhere
22/tcp      ALLOW       Anywhere
```

---

## 🔄 Étape 12 : Configurer Systemd (lancement automatique)

### 12.1 Créer le service

```bash
nano /etc/systemd/system/tts-api.service
```

### 12.2 Copier cette configuration

```ini
[Unit]
Description=Fon TTS API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/tts-api
Environment="PATH=/opt/tts-api/venv/bin"
ExecStart=/opt/tts-api/venv/bin/python /opt/tts-api/api.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 12.3 Sauvegarder
- `Ctrl + O` → Enter → `Ctrl + X`

### 12.4 Activer le service

```bash
# Recharger systemd
systemctl daemon-reload

# Démarrer le service
systemctl start tts-api

# Vérifier le statut
systemctl status tts-api
```

✅ Doit afficher : `Active: active (running)`

### 12.5 Activer au démarrage

```bash
systemctl enable tts-api
```

---

## 🧪 Étape 13 : Tester depuis votre PC

**Ouvrir un navigateur sur votre PC** :

```
http://VOTRE_IP_VPS:8000/docs
```

✅ Vous devriez voir l'interface Swagger de l'API !

### Test rapide :

```bash
# Depuis PowerShell sur votre PC
curl http://VOTRE_IP:8000/health
```

---

## 📊 Étape 14 : Commandes utiles

### Voir les logs en temps réel

```bash
journalctl -u tts-api -f
```

### Redémarrer le service

```bash
systemctl restart tts-api
```

### Arrêter le service

```bash
systemctl stop tts-api
```

### Voir le statut

```bash
systemctl status tts-api
```

---

## 🔐 Étape 15 : Sécurité (OPTIONNEL mais recommandé)

### 15.1 Créer un utilisateur non-root

```bash
# Créer utilisateur
adduser ttsuser

# Donner les permissions
chown -R ttsuser:ttsuser /opt/tts-api
```

### 15.2 Modifier le service

```bash
nano /etc/systemd/system/tts-api.service
```

Changer `User=root` en `User=ttsuser`

```bash
systemctl daemon-reload
systemctl restart tts-api
```

---

## 👤 Étape 16 : Créer un nouvel utilisateur avec accès SSH

Pour donner accès au VPS à un autre développeur ou administrateur :

### 16.1 Créer l'utilisateur

```bash
# Créer un nouvel utilisateur (remplacer 'newuser' par le nom souhaité)
adduser newuser
```

Suivez les instructions :
- **Mot de passe** : Entrez un mot de passe sécurisé (2 fois)
- **Informations** : Appuyez sur Enter pour chaque question (optionnel)

### 16.2 Donner les privilèges sudo (optionnel)

Si l'utilisateur doit exécuter des commandes administrateur :

```bash
# Ajouter au groupe sudo
usermod -aG sudo newuser
```

### 16.3 Configurer l'accès SSH avec mot de passe

#### Vérifier la configuration SSH

```bash
nano /etc/ssh/sshd_config
```

Assurez-vous que ces lignes sont présentes et non commentées :

```
PasswordAuthentication yes
PubkeyAuthentication yes
PermitRootLogin yes
```

#### Redémarrer SSH

```bash
systemctl restart sshd
```

### 16.4 Connexion du nouvel utilisateur

Le nouvel utilisateur peut maintenant se connecter :

**Via PuTTY :**
1. Host Name : `VOTRE_IP_VPS`
2. Port : `22`
3. Cliquer **"Open"**
4. login as : `newuser`
5. password : `[mot de passe créé]`

**Via SSH (Linux/Mac) :**
```bash
ssh newuser@VOTRE_IP_VPS
```

### 16.5 Sécurité renforcée : Clé SSH (Recommandé)

Pour une sécurité maximale, utilisez des clés SSH :

#### Sur Windows (via PuTTYgen)

1. **Générer la clé** :
   - Ouvrir **PuTTYgen**
   - Type : `RSA`
   - Number of bits : `4096`
   - Cliquer **"Generate"**
   - Bouger la souris pour générer l'aléatoire

2. **Sauvegarder** :
   - Copier la **clé publique** (zone du haut)
   - Cliquer **"Save private key"** → `newuser_key.ppk`

3. **Sur le VPS** (connecté en root) :
   ```bash
   # Se connecter en tant que nouvel utilisateur
   su - newuser
   
   # Créer le dossier SSH
   mkdir -p ~/.ssh
   chmod 700 ~/.ssh
   
   # Créer le fichier de clés autorisées
   nano ~/.ssh/authorized_keys
   ```
   
   - **Coller la clé publique** (celle copiée depuis PuTTYgen)
   - Sauvegarder : `Ctrl + O` → Enter → `Ctrl + X`
   
   ```bash
   # Permissions
   chmod 600 ~/.ssh/authorized_keys
   
   # Retour root
   exit
   ```

4. **Connexion avec PuTTY** :
   - Host Name : `VOTRE_IP_VPS`
   - Connection → SSH → Auth → Private key file : `newuser_key.ppk`
   - Session → Saved Sessions : `MonVPS-NewUser`
   - Cliquer **"Save"** puis **"Open"**

### 16.6 Désactiver connexion par mot de passe (Sécurité max)

**ATTENTION** : Ne faites ceci qu'après avoir vérifié que les clés SSH fonctionnent !

```bash
nano /etc/ssh/sshd_config
```

Modifier :
```
PasswordAuthentication no
```

Redémarrer :
```bash
systemctl restart sshd
```

### 16.7 Supprimer un utilisateur

Si nécessaire :

```bash
# Supprimer utilisateur et son dossier home
deluser --remove-home newuser
```

---

## 🌐 Étape 17 : Configuration Nginx (Production)

Si vous voulez utiliser un nom de domaine (ex: `tts.biopension.bj`) :

```bash
# Installer Nginx
apt install -y nginx

# Créer config
nano /etc/nginx/sites-available/tts-api
```

**Configuration** :

```nginx
server {
    listen 80;
    server_name tts.biopension.bj;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**Activer** :

```bash
ln -s /etc/nginx/sites-available/tts-api /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

---

## ✅ Checklist Finale

- [ ] Connexion PuTTY réussie
- [ ] Python 3.12 installé
- [ ] Fichiers transférés
- [ ] Packages installés
- [ ] Service systemd actif
- [ ] Pare-feu configuré
- [ ] API accessible depuis l'extérieur
- [ ] Test `/health` réussi

---

## 🆘 Dépannage

### Problème : "Connection refused"

```bash
# Vérifier que le service tourne
systemctl status tts-api

# Vérifier les logs
journalctl -u tts-api -n 50
```

### Problème : "ModuleNotFoundError"

```bash
# Réinstaller les dépendances
source /opt/tts-api/venv/bin/activate
pip install -r requirements.txt
```

### Problème : "Out of memory"

Votre VPS a besoin de **minimum 4 GB de RAM** pour les modèles TTS.

---

## 📞 URL Finales

- **Documentation** : `http://VOTRE_IP:8000/docs`
- **Health check** : `http://VOTRE_IP:8000/health`
- **TTS Fon** : `POST http://VOTRE_IP:8000/tts/fon`
- **TTS Français** : `POST http://VOTRE_IP:8000/tts/fr-direct`

---

**Bon déploiement ! 🚀**
