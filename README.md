# RMIS

Statički sajt sa tri sekcije — **Vežbe**, **Teorija** i **Seminarski radovi** — sa uploadom fajlova (PDF, PPTX, DOCX…) direktno iz browsera.

Sajt: https://lazicmilos.github.io/RMIS/

## Kako radi

- Hostovan na GitHub Pages, bez servera.
- Fajlovi se čuvaju u repozitorijumu: `files/vezbe/`, `files/teorija/`, `files/seminarski/`.
- Spisak fajlova se čita preko GitHub API-ja (jedan zahtev po učitavanju sajta).
- Upload/brisanje radi preko GitHub API-ja uz lični token — svaki upload je jedan commit.
- Pregled u browseru: PDF preko [PDF.js](https://mozilla.github.io/pdf.js/) (hostovan lokalno u `assets/vendor/pdfjs/`),
  PPTX/DOCX/XLSX preko Microsoft Office viewera (radi samo na javnom sajtu; do 10 MB, Excel do 5 MB), TXT direktno.

## Upload

1. Napravi [fine-grained token](https://github.com/settings/personal-access-tokens/new):
   *Repository access* → samo `RMIS`, *Permissions* → **Contents: Read and write**.
2. Na sajtu klikni **Prijava**, nalepi token.
3. Uđi u sekciju i prevuci fajlove (max 25 MB po fajlu).

Token ostaje samo u tvom browseru. Bez tokena posetioci mogu samo da gledaju i preuzimaju fajlove.

Fajlove možeš dodati i ručno: GitHub → `files/<sekcija>/` → *Add file → Upload files*.

## Struktura

```
index.html
assets/config.js   # repo, grana, sekcije, dozvoljeni tipovi
assets/github.js   # GitHub API klijent
assets/app.js      # UI i rutiranje
assets/preview.js  # pregled fajlova
assets/style.css
files/<sekcija>/   # materijali
```
