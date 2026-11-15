"""Analyse les recettes partagées (issues GitHub) et met à jour data/recipes.json.

Chaque partage depuis Instagram/TikTok crée une issue « [recette] ... » sur le dépôt.
Ce script :
  1. lit les issues ouvertes (créées par le propriétaire du dépôt uniquement),
  2. télécharge la vidéo (yt-dlp) + sa description,
  3. demande à Gemini (gratuit) de regarder/écouter la vidéo et d'en extraire la recette,
  4. écrit data/recipes.json + la miniature dans img/,
  5. note les issues traitées dans .done_issues.json (fermées après le push).

Usage local (test) :  python scripts/process.py --url <lien> --par Néo
Fermer les issues  :  python scripts/process.py --close-issues
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import sys
import tempfile
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "recipes.json"
IMG_DIR = ROOT / "img"
DONE_FILE = ROOT / ".done_issues.json"

GH_API = "https://api.github.com"
GEMINI_API = "https://generativelanguage.googleapis.com"
# Chaque modèle a son propre quota gratuit par jour : quand l'un est épuisé, on passe au suivant.
MODELS = [m for m in [os.environ.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-flash-lite-latest",
                      "gemini-2.5-flash", "gemini-2.5-flash-lite"] if m]
EXHAUSTED: set[str] = set()
INLINE_MAX = 15 * 1024 * 1024  # au-delà : upload via l'API Files
GIVE_UP_AFTER = dt.timedelta(days=7)  # erreurs temporaires (quota) : on réessaie pendant 7 jours

TYPES = ["plat", "entrée", "apéro", "dessert", "petit-déj", "goûter", "boisson", "sauce", "autre"]
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"}


class Transient(Exception):
    """Erreur passagère (quota, serveur) : on garde l'issue ouverte pour réessayer."""


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- données
def load_recipes() -> list[dict]:
    if DATA.exists():
        return json.loads(DATA.read_text(encoding="utf-8") or "[]")
    return []


def save_recipes(recipes: list[dict]) -> None:
    DATA.parent.mkdir(parents=True, exist_ok=True)
    recipes.sort(key=lambda r: r.get("ajoute_le", ""), reverse=True)
    DATA.write_text(json.dumps(recipes, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- liens
URL_RE = re.compile(r"https?://[^\s\"'<>]+")


def canonical(url: str) -> tuple[str, str]:
    """Renvoie (id stable, url propre). Résout les liens courts TikTok."""
    url = url.strip().rstrip(").,;")
    if re.search(r"(vm|vt)\.tiktok\.com|tiktok\.com/t/", url):
        try:
            url = requests.get(url, headers=UA, allow_redirects=True, timeout=20).url
        except requests.RequestException:
            pass
    m = re.search(r"instagram\.com/(?:[\w.]+/)?(?:p|reel|reels|tv)/([\w-]+)", url)
    if m:
        return f"ig_{m.group(1)}", f"https://www.instagram.com/reel/{m.group(1)}/"
    m = re.search(r"tiktokv?\.com/(?:@([\w.-]*)/(?:video|photo)|share/video|embed(?:/v2)?)/(\d+)", url)
    if m:  # les exports TikTok donnent des liens tiktokv.com/share/video/<id>
        return f"tt_{m.group(2)}", f"https://www.tiktok.com/@{m.group(1) or ''}/video/{m.group(2)}"
    clean = url.split("?")[0]
    return "x_" + hashlib.sha1(clean.encode()).hexdigest()[:12], clean


def platform(rid: str) -> str:
    return {"ig": "instagram", "tt": "tiktok"}.get(rid[:2], "autre")


# ---------------------------------------------------------------- récupération vidéo / description
def fetch_video(url: str, workdir: Path) -> tuple[dict, Path | None]:
    """Télécharge la vidéo en basse qualité. Renvoie (métadonnées, chemin ou None)."""
    import yt_dlp

    opts = {
        "outtmpl": str(workdir / "%(id)s.%(ext)s"),
        "format_sort": ["res:480", "ext:mp4:m4a", "size"],
        "max_filesize": 80 * 1024 * 1024,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "noplaylist": True,
        "playlist_items": "1",
        "socket_timeout": 30,
    }
    cookies = os.environ.get("YTDLP_COOKIES_FILE")
    if cookies and Path(cookies).exists():
        opts["cookiefile"] = cookies
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info.get("_type") == "playlist" and info.get("entries"):
                info = info["entries"][0]
            path = None
            for d in info.get("requested_downloads") or []:
                p = Path(d.get("filepath") or "")
                if p.exists():
                    path = p
            meta = {
                "description": info.get("description") or "",
                "titre": info.get("title") or "",
                "auteur": info.get("uploader") or info.get("channel") or info.get("uploader_id") or "",
                "miniature": info.get("thumbnail") or "",
                "duree": info.get("duration"),
            }
            return meta, path
    except Exception as e:  # noqa: BLE001 - yt-dlp lève beaucoup de types différents
        log(f"   yt-dlp a échoué : {str(e)[:200]}")
        return {}, None


def save_thumbnail(src: str, rid: str) -> str | None:
    if not src:
        return None
    try:
        r = requests.get(src, headers=UA, timeout=30)
        r.raise_for_status()
        IMG_DIR.mkdir(exist_ok=True)
        out = IMG_DIR / f"{rid}.jpg"
        try:
            from io import BytesIO
            from PIL import Image

            im = Image.open(BytesIO(r.content)).convert("RGB")
            im.thumbnail((480, 720))
            im.save(out, "JPEG", quality=78, optimize=True)
        except Exception:  # noqa: BLE001 - Pillow absent ou format exotique
            out.write_bytes(r.content)
        return f"img/{rid}.jpg"
    except requests.RequestException as e:
        log(f"   miniature non récupérée : {e}")
        return None


# ---------------------------------------------------------------- Gemini
SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "est_recette": {"type": "BOOLEAN"},
        "titre": {"type": "STRING"},
        "temps_min": {"type": "INTEGER", "nullable": True},
        "type": {"type": "STRING", "enum": TYPES},
        "portions": {"type": "INTEGER", "nullable": True},
        "ingredients": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {"nom": {"type": "STRING"}, "base": {"type": "STRING"}},
                "required": ["nom", "base"],
            },
        },
        "etapes": {"type": "ARRAY", "items": {"type": "STRING"}},
        "confiance": {"type": "STRING", "enum": ["haute", "moyenne", "basse"]},
    },
    "required": ["est_recette", "titre", "type", "ingredients", "etapes", "confiance"],
}

PROMPT = """Tu es un assistant culinaire. Tu reçois une vidéo de recette (TikTok/Instagram) et sa description.
Extrais la recette complète, en français.

- REGARDE et ÉCOUTE la vidéo : les ingrédients et quantités sont souvent dits à l'oral ou écrits à l'écran,
  et pas dans la description. Croise toutes les sources.
- "nom" = l'ingrédient tel qu'affiché, avec quantité (ex : "2 blancs de poulet émincés", "200 g de feta").
- "base" = nom générique pour la recherche : minuscules, singulier, sans quantité ni préparation
  (ex : "poulet", "feta", "tomate cerise", "huile d'olive", "oignon rouge", "pâte feuilletée").
- "etapes" = étapes courtes et claires, dans l'ordre.
- "temps_min" = temps total estimé (préparation + cuisson) en minutes.
- "titre" = nom court et appétissant de la recette (pas le texte de la vidéo).
- Si ce n'est pas une recette, mets est_recette=false.
- "confiance" = basse si tu as dû deviner beaucoup de choses.

Description de la publication :
---
{description}
---"""


def gemini_call(key: str, parts: list[dict]) -> dict:
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.2},
    }
    errors = []
    for model in MODELS:
        if model in EXHAUSTED:
            continue
        for attempt in range(3):
            r = requests.post(f"{GEMINI_API}/v1beta/models/{model}:generateContent",
                              params={"key": key}, json=body, timeout=300)
            if r.ok:
                j = r.json()
                try:
                    text = j["candidates"][0]["content"]["parts"][0]["text"]
                except (KeyError, IndexError):
                    raise RuntimeError(f"Réponse Gemini vide : {json.dumps(j)[:300]}")
                return json.loads(text)
            msg = f"{model} → {r.status_code} {r.text[:160]}".replace("\n", " ")
            if r.status_code == 429 and re.search(r"per ?day|PerDay|daily", r.text, re.I):
                log(f"   quota du jour épuisé pour {model}, modèle suivant")
                EXHAUSTED.add(model)  # inutile de le réessayer pendant ce run
                errors.append(msg)
                break
            if r.status_code in (429, 500, 502, 503, 504):  # limite par minute ou panne passagère : on attend
                time.sleep(20 * (attempt + 1))
                continue
            errors.append(msg)  # 400/403/404 : ce modèle ne convient pas, on essaie le suivant
            log(f"   {msg}")
            break
        else:
            errors.append(msg)
    raise Transient("Gemini indisponible : " + " | ".join(errors)[:600])


def gemini_upload(key: str, path: Path, mime: str) -> tuple[str, str]:
    size = path.stat().st_size
    r = requests.post(f"{GEMINI_API}/upload/v1beta/files", params={"key": key}, timeout=60, headers={
        "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": str(size), "X-Goog-Upload-Header-Content-Type": mime,
    }, json={"file": {"display_name": path.name}})
    r.raise_for_status()
    up = r.headers["x-goog-upload-url"]
    r = requests.post(up, data=path.read_bytes(), timeout=300, headers={
        "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize"})
    r.raise_for_status()
    f = r.json()["file"]
    for _ in range(60):  # la vidéo doit être "ACTIVE" avant usage
        if f.get("state") == "ACTIVE":
            return f["uri"], f["name"]
        if f.get("state") == "FAILED":
            raise RuntimeError("Gemini n'a pas pu lire la vidéo")
        time.sleep(3)
        f = requests.get(f"{GEMINI_API}/v1beta/{f['name']}", params={"key": key}, timeout=30).json()
    raise Transient("Vidéo jamais prête chez Gemini")


def analyse(key: str, description: str, video: Path | None) -> dict:
    parts: list[dict] = []
    uploaded = None
    if video:
        mime = mimetypes.guess_type(video.name)[0] or "video/mp4"
        if video.stat().st_size <= INLINE_MAX:
            parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(video.read_bytes()).decode()}})
        else:
            uri, uploaded = gemini_upload(key, video, mime)
            parts.append({"file_data": {"mime_type": mime, "file_uri": uri}})
    parts.append({"text": PROMPT.format(description=description.strip() or "(aucune description)")})
    try:
        return gemini_call(key, parts)
    finally:
        if uploaded:
            requests.delete(f"{GEMINI_API}/v1beta/{uploaded}", params={"key": key}, timeout=30)


# ---------------------------------------------------------------- traitement d'un lien
def extract(url: str, rid: str, key: str | None) -> dict:
    """Construit la fiche recette. Lève Transient si on doit réessayer plus tard."""
    with tempfile.TemporaryDirectory() as tmp:
        meta, video = fetch_video(url, Path(tmp))
        desc = meta.get("description", "")
        fiche = {
            "titre": (desc.strip().splitlines() or ["Recette sans titre"])[0][:80],
            "auteur_video": meta.get("auteur", ""),
            "temps_min": None, "type": "autre", "portions": None,
            "ingredients": [], "etapes": [],
            "image": save_thumbnail(meta.get("miniature", ""), rid),
            "statut": "a_completer", "source_extraction": None, "note": "",
        }
        if not key:
            fiche["note"] = "Pas de clé Gemini : à compléter à la main."
            return fiche
        if not video and not desc:
            fiche["note"] = "Vidéo et description inaccessibles (compte privé ou blocage). À compléter à la main."
            return fiche
        res = analyse(key, desc, video)
        fiche.update({
            "titre": res.get("titre") or fiche["titre"],
            "temps_min": res.get("temps_min"),
            "type": res.get("type") if res.get("type") in TYPES else "autre",
            "portions": res.get("portions"),
            "ingredients": [{"nom": i["nom"].strip(), "base": i["base"].strip().lower()}
                            for i in res.get("ingredients", []) if i.get("nom")],
            "etapes": [e.strip() for e in res.get("etapes", []) if e.strip()],
            "source_extraction": "video" if video else "description",
        })
        if not res.get("est_recette", True):
            fiche["note"] = "L'IA pense que ce n'est pas une recette."
        elif not fiche["ingredients"]:
            fiche["note"] = "Aucun ingrédient trouvé : à compléter à la main."
        elif res.get("confiance") == "basse":
            fiche["statut"] = "ok"
            fiche["note"] = "Extraction incertaine : vérifie les ingrédients."
        else:
            fiche["statut"] = "ok"
        if not video:
            fiche["note"] = (fiche["note"] + " Vidéo non téléchargée, analyse de la description seule.").strip()
        return fiche


# ---------------------------------------------------------------- publication (sans conflit)
CHECKPOINT_EVERY = 3
TOUCHED: set[str] = set()   # recettes ajoutées/modifiées pendant ce run
DELETED: set[str] = set()   # recettes supprimées pendant ce run
_since_publish = 0


def _git(*args: str):
    import subprocess
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")


def publish(recipes: list[dict]) -> None:
    """Enregistre les recettes. Sur GitHub Actions, fusionne avec la dernière version en ligne
    (seules les recettes touchées par ce run sont écrites) puis pousse : jamais de conflit git."""
    global _since_publish
    _since_publish = 0
    save_recipes(recipes)
    if not os.environ.get("GITHUB_ACTIONS"):
        return
    for attempt in range(5):
        _git("fetch", "-q", "origin", "main")
        _git("reset", "-q", "--mixed", "origin/main")  # HEAD = version en ligne, nos fichiers restent sur le disque
        shown = _git("show", "origin/main:data/recipes.json")
        theirs = json.loads(shown.stdout or "[]") if shown.returncode == 0 else []
        mine = {r["id"]: r for r in recipes if r["id"] in TOUCHED}
        merged = {r["id"]: r for r in theirs if r["id"] not in DELETED}
        merged.update(mine)
        recipes[:] = list(merged.values())
        save_recipes(recipes)
        paths = ["data/recipes.json"] + [r["image"] for r in mine.values() if r.get("image") and (ROOT / r["image"]).exists()]
        _git("add", "--", *paths)
        for rid in DELETED:
            _git("rm", "-q", "--cached", "--ignore-unmatch", f"img/{rid}.jpg")
        if _git("diff", "--cached", "--quiet").returncode == 0:
            return
        _git("commit", "-q", "-m", "Recettes mises à jour")
        r = _git("push", "-q", "origin", "HEAD:main")
        if r.returncode == 0:
            log(f"   ✔ {len(mine)} recette(s) publiée(s)")
            return
        log(f"   push refusé (essai {attempt + 1}/5), on refusionne : {r.stderr.strip()[:150]}")
        time.sleep(3 + attempt * 3)
    raise RuntimeError("Impossible de publier les recettes après 5 essais")


def checkpoint(recipes: list[dict]) -> None:
    """Pendant un gros import : publie toutes les 3 recettes, sans attendre la fin."""
    global _since_publish
    _since_publish += 1
    if _since_publish >= CHECKPOINT_EVERY:
        publish(recipes)


# ---------------------------------------------------------------- commandes (issues)
def parse_command(body: str) -> dict:
    body = (body or "").strip()
    try:
        cmd = json.loads(body)
        if isinstance(cmd, dict) and cmd.get("action"):
            return cmd
    except json.JSONDecodeError:
        pass
    par = re.search(r"^\s*par\s*:\s*(.+)$", body, re.M | re.I)
    name = URL_RE.sub("", par.group(1)).strip() if par else ""  # « par: Léa https://… » sur une seule ligne
    return {"action": "ajout", "urls": URL_RE.findall(body), "par": name}


def apply_command(cmd: dict, recipes: list[dict], key: str | None, now: str) -> list[str]:
    """Applique une commande. Renvoie un résumé ; lève Transient si à réessayer."""
    by_id = {r["id"]: r for r in recipes}
    action = cmd.get("action")
    out: list[str] = []
    if action == "ajout":
        par = (cmd.get("par") or "").strip() or "?"
        for raw in cmd.get("urls", []):
            if not re.search(r"instagram\.com|tiktok\.com", raw):
                out.append(f"ignoré (pas Insta/TikTok) : {raw}")
                continue
            rid, url = canonical(raw)
            if rid in by_id:  # déjà là : on ajoute juste la personne
                if par not in by_id[rid]["par"]:
                    by_id[rid]["par"].append(par)
                    TOUCHED.add(rid)
                out.append(f"déjà présente : {by_id[rid]['titre']}")
                continue
            log(f" → {url}")
            fiche = extract(url, rid, key)
            rec = {"id": rid, "url": url, "plateforme": platform(rid), "par": [par], "ajoute_le": now, **fiche}
            recipes.append(rec)
            by_id[rid] = rec
            TOUCHED.add(rid)
            out.append(f"{'✅' if rec['statut'] == 'ok' else '⚠️'} {rec['titre']} {rec['note']}".strip())
            checkpoint(recipes)
            time.sleep(4)  # ménage le quota gratuit de Gemini
    elif action == "modif":
        r = by_id.get(cmd.get("id"))
        if r:
            allowed = {"titre", "temps_min", "type", "portions", "ingredients", "etapes", "par"}
            r.update({k: v for k, v in (cmd.get("data") or {}).items() if k in allowed})
            r["statut"], r["note"], r["source_extraction"] = "ok", "", "manuel"
            TOUCHED.add(r["id"])
            out.append(f"modifiée : {r['titre']}")
    elif action == "suppr":
        r = by_id.get(cmd.get("id"))
        if r:
            recipes.remove(r)
            DELETED.add(r["id"])
            TOUCHED.discard(r["id"])
            if r.get("image"):
                (ROOT / r["image"]).unlink(missing_ok=True)
            out.append(f"supprimée : {r['titre']}")
    elif action == "reessayer":
        r = by_id.get(cmd.get("id"))
        if r:
            log(f" → (réessai) {r['url']}")
            r.update(extract(r["url"], r["id"], key))
            TOUCHED.add(r["id"])
            out.append(f"réanalysée : {r['titre']} {r['note']}".strip())
    else:
        out.append(f"commande inconnue : {action}")
    return out


# ---------------------------------------------------------------- GitHub
def gh(method: str, path: str, **kw):
    r = requests.request(method, GH_API + path, timeout=30, headers={
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "Accept": "application/vnd.github+json"}, **kw)
    r.raise_for_status()
    return r.json() if r.text else None


def run_issues() -> int:
    repo = os.environ["GITHUB_REPOSITORY"]
    owner = repo.split("/")[0].lower()
    key = os.environ.get("GEMINI_API_KEY") or None
    issues = [i for i in gh("GET", f"/repos/{repo}/issues", params={"state": "open", "per_page": 100})
              if "pull_request" not in i and i["user"]["login"].lower() == owner
              and i["title"].lower().startswith("[recette]")]
    issues.sort(key=lambda i: i["number"])
    log(f"{len(issues)} demande(s) à traiter")
    recipes = load_recipes()
    done = []
    for issue in issues:
        log(f"#{issue['number']} {issue['title']}")
        cmd = parse_command(issue.get("body") or "")
        try:
            summary = apply_command(cmd, recipes, key, issue["created_at"])
            done.append({"n": issue["number"], "msg": "\n".join(summary) or "rien à faire"})
        except Transient as e:
            age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(issue["created_at"].replace("Z", "+00:00"))
            log(f"   temporaire : {e}")
            if age > GIVE_UP_AFTER:
                for raw in cmd.get("urls", []):
                    rid, url = canonical(raw)
                    if rid not in {r["id"] for r in recipes}:
                        TOUCHED.add(rid)
                        recipes.append({"id": rid, "url": url, "plateforme": platform(rid),
                                        "par": [cmd.get("par") or "?"], "ajoute_le": issue["created_at"],
                                        "titre": "Recette à compléter", "auteur_video": "", "temps_min": None,
                                        "type": "autre", "portions": None, "ingredients": [], "etapes": [],
                                        "image": None, "statut": "a_completer", "source_extraction": None,
                                        "note": "L'analyse a échoué plusieurs fois (quota Gemini ?)."})
                done.append({"n": issue["number"], "msg": f"abandon après 7 jours : {e}"})
        except Exception as e:  # noqa: BLE001 - une issue cassée ne doit pas bloquer les autres
            log(f"   erreur : {e}")
            done.append({"n": issue["number"], "msg": f"erreur : {str(e)[:300]}"})
    publish(recipes)
    DONE_FILE.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
    return 0


def close_issues() -> int:
    repo = os.environ["GITHUB_REPOSITORY"]
    if not DONE_FILE.exists():
        return 0
    for d in json.loads(DONE_FILE.read_text(encoding="utf-8")):
        log(f"#{d['n']} : {d['msg']}")  # résumé dans le journal du robot (un commentaire enverrait un mail)
        gh("PATCH", f"/repos/{repo}/issues/{d['n']}", json={"state": "closed"})
    DONE_FILE.unlink()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="test local : analyse ce lien et l'ajoute à data/recipes.json")
    ap.add_argument("--par", default="test")
    ap.add_argument("--close-issues", action="store_true")
    a = ap.parse_args()
    if a.close_issues:
        return close_issues()
    if a.url:
        recipes = load_recipes()
        now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for line in apply_command({"action": "ajout", "urls": [a.url], "par": a.par}, recipes,
                                  os.environ.get("GEMINI_API_KEY"), now):
            log(line)
        save_recipes(recipes)
        return 0
    return run_issues()


if __name__ == "__main__":
    sys.exit(main())
