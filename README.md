# Nos recettes

Nos recettes Instagram et TikTok au même endroit. Tu tapes ce qu'il y a dans le frigo, l'appli te dit ce que tu peux cuisiner.

## Comment ça marche

1. Sur Instagram ou TikTok : **Partager → Recettes** (au lieu d'Enregistrer).
2. Un robot gratuit (GitHub Actions) télécharge la vidéo et la donne à **Gemini**, l'IA gratuite de Google. Gemini **regarde et écoute** la vidéo : il trouve les ingrédients même s'ils ne sont pas dans la description.
3. Environ 2 minutes plus tard, la fiche apparaît dans l'appli : ingrédients, étapes, temps, type, et qui l'a ajoutée.

Coût : **0 €**. GitHub est gratuit pour un dépôt public, et l'API Gemini a une offre gratuite.

---

## Mise en place (une seule fois)

### 1. Clé Gemini (Néo, 2 min)
1. Va sur <https://aistudio.google.com/apikey> et connecte-toi avec un compte Google.
2. Clique sur **Create API key** et copie la clé.
3. Dans un terminal, lance la commande ci-dessous, puis colle la clé quand elle est demandée :
   ```
   gh secret set GEMINI_API_KEY -R neocpt/recettes
   ```

### 2. Code d'accès (Néo, 2 min)
Ce code permet aux téléphones d'ajouter des recettes. Il ne donne accès à rien d'autre.
1. Va sur <https://github.com/settings/personal-access-tokens/new>.
2. Remplis :
   - Nom : `recettes`
   - Expiration : la plus longue possible
   - **Repository access → Only select repositories → recettes**
   - **Permissions → Repository permissions → Issues → Read and write**
3. Clique sur **Generate token** et copie le code (`github_pat_…`). Garde-le pour vous deux, ne le publie nulle part.

### 3. Android (Néo)
1. Ouvre <https://neocpt.github.io/recettes/> dans **Chrome**.
2. Menu ⋮ → **Installer l'appli** (ou **Ajouter à l'écran d'accueil**).
3. Ouvre l'appli depuis l'écran d'accueil, puis ⚙️ → ton prénom + le code d'accès → Enregistrer.
4. Pour ajouter une recette :
   - Instagram : ➤ → **Partager vers…** → **Recettes**.
   - TikTok : **Partager → Plus** → **Recettes**.

### 4. iPhone (ta copine)
L'iPhone ne laisse pas un site apparaître dans le menu Partager. On passe donc par un **Raccourci** (appli Raccourcis, déjà installée).

**L'appli (pour chercher) :**
1. Ouvre <https://neocpt.github.io/recettes/> dans **Safari**.
2. Bouton Partager → **Sur l'écran d'accueil**.
3. Dans l'appli : ⚙️ → son prénom + le code d'accès.

**Le raccourci (pour ajouter) :**
1. Ouvre l'appli **Raccourcis** → **+**. Renomme le raccourci « Recettes ».
2. Touche ⓘ (en bas) → active **Afficher dans la feuille de partage**. Dans les types acceptés, ne garde que **URL** et **Texte**.
3. Ajoute l'action **Obtenir le contenu de l'URL** :
   - URL : `https://api.github.com/repos/neocpt/recettes/issues`
   - Touche ▸ pour afficher les options :
     - Méthode : **POST**
     - En-têtes :
       - `Authorization` = `Bearer ` suivi du code d'accès (avec l'espace après Bearer)
       - `Accept` = `application/vnd.github+json`
     - Corps de la requête : **JSON**, avec deux champs Texte :
       - `title` = `[recette] ajout`
       - `body` = `par: Prénom` (son prénom), puis un retour à la ligne, puis la variable **Entrée du raccourci**
4. Ajoute l'action **Afficher une notification** avec le texte « Recette ajoutée ✅ ».
5. Pour ajouter une recette :
   - Instagram : ➤ → **Partager vers…** → **Recettes**.
   - TikTok : **Partager → Plus** → **Recettes**.

---

## Importer les recettes déjà enregistrées (une fois chacun)
Instagram ne laisse aucune appli lire tes enregistrements. En revanche, il permet de les **exporter** :

1. Instagram → Profil → ☰ → **Espace Comptes** → **Vos informations et autorisations** → **Télécharger vos informations**. Les noms de menus peuvent varier un peu.
2. **Télécharger ou transférer des informations** → ton compte → **Certaines de vos informations** → coche **Enregistrées**.
3. **Télécharger sur l'appareil** → Période : **Depuis le début** → Format : **JSON** → Qualité : basse → **Créer les fichiers**.
4. Instagram envoie un e-mail quand le fichier est prêt (de quelques minutes à quelques heures). Télécharge le `.zip`.
5. Dans l'appli : ⚙️ → **Importer d'un coup** → choisis le `.zip` → coche la collection « recette » → **Importer**.

Ça marche aussi avec l'export TikTok (Paramètres → Compte → Télécharger vos données → JSON) pour les vidéos en favoris.

Les recettes déjà présentes ne sont pas ajoutées deux fois. Si vous avez enregistré la même vidéo tous les deux, elle porte vos deux prénoms.

---

## Utiliser l'appli
- **Frigo** : tape tes ingrédients (Entrée ou virgule entre chaque). L'appli montre :
  - les recettes que tu peux faire ;
  - celles où il manque 1 ingrédient ;
  - celles où il en manque 2.
- **Basiques** : sel, poivre, huile, sucre, farine et eau ne comptent pas dans la recherche. Tu peux changer la liste dans ⚙️.
- **Filtres** : temps de préparation, type de plat, qui l'a ajoutée.
- **🎲 Au hasard** : tire une recette parmi celles affichées.
- **Fiche recette** : ✓ = tu l'as, ✗ = il te manque. Lien vers la vidéo. Boutons Modifier, Réanalyser et Supprimer.
- **« À compléter »** : l'IA n'a pas réussi (vidéo bloquée ou recette introuvable). Ouvre la fiche → ✏️ Modifier.

## Limites connues
- Instagram bloque parfois le téléchargement depuis les serveurs de GitHub. La recette arrive alors « à compléter » avec son lien : il faut la remplir à la main ou réessayer plus tard.
- Offre gratuite de Gemini : le nombre d'analyses par minute et par jour est limité (largement suffisant pour vous deux). Google peut utiliser les vidéos envoyées pour améliorer ses modèles. Ici, ce ne sont que des vidéos publiques.
- Le dépôt est public : la liste des recettes et vos prénoms sont visibles par quelqu'un qui tomberait dessus. Le code d'accès, lui, reste privé.

## Technique (pour plus tard)
- `index.html`, `app.js`, `style.css`, `common.js` : l'appli (site installable, sans dépendance).
- `share.html` : la page qui reçoit un partage et crée une demande (issue GitHub `[recette] …`).
- `.github/workflows/process.yml` + `scripts/process.py` : le robot. Il utilise yt-dlp, puis Gemini, puis écrit `data/recipes.json` et `img/`.
- Test local d'un lien : `python scripts/process.py --url <lien> --par Néo` (avec la variable `GEMINI_API_KEY`).
- Seules les demandes créées avec le compte du propriétaire sont traitées. Un inconnu ne peut donc pas ajouter de recettes.
