# Garasjeport

Mobilvennlig webapp som viser status for garasjeporten og sender relépuls via The Things Network (TTN).

```
LT-22222-L ──LoRa──▶ LPS8N ──▶ TTN (eu1) ──webhook──▶ Cloudflare Worker (+ Durable Object)
                                  ▲                        ▲
                                  └──── downlink (puls) ───┤
                                                           │ fetch med tilgangstoken
                                              GitHub Pages-frontend (docs/)
```

| Mappe/fil | Innhold |
|---|---|
| `src/index.js` | Workeren: sjekker webhook-hemmelighet, tilgangstoken og CORS, og sender videre til Durable Object-en |
| `src/garage.js` | Durable Object-en `GarageState`: lagrer status, historikk og tellere, og sender relépuls til TTN |
| `src/logic.js` | Statuslogikk, regler for kommandoer, budsjett (testes separat) |
| `wrangler.toml` | Oppsett for Workeren (ikke-hemmelige innstillinger) |
| `docs/` | Frontend som GitHub Pages publiserer |
| `test/` | Automatiske tester (`npm test`) |

---

## Oppsett, trinn for trinn

Alle kommandoer kjøres i **PowerShell** i prosjektmappen (der `package.json` ligger). I VS Code: *Terminal → New Terminal*.

### 1. Installer avhengigheter

```powershell
npm install
```
Laster ned `wrangler`, Cloudflares verktøy for å teste og publisere Workers, til mappen `node_modules`.

```powershell
npm test
```
Kjører testene. Alle skal vise `pass`.

### 2. Logg inn på Cloudflare

Har du ikke konto: lag en gratis på <https://dash.cloudflare.com/sign-up>.

```powershell
npx wrangler login
```
Åpner nettleseren. Godkjenn tilgangen, så husker `wrangler` innloggingen på denne PC-en.

### 3. Lag KV-lagringen

```powershell
npx wrangler kv namespace create GARAGE
```
Lager en liten nøkkel/verdi-database hos Cloudflare. (Workeren lagrer nå alt i Durable Object-en `GarageState`, som opprettes automatisk ved deploy. KV brukes bare én gang, til å kopiere over data fra før Durable Object-en kom. Nye installasjoner trenger egentlig ikke dette trinnet.) Kommandoen skriver ut noe sånt som:

```
[[kv_namespaces]]
binding = "GARAGE"
id = "3f2a9c...."
```
Kopier `id`-verdien inn i `wrangler.toml` i stedet for `FYLL_INN_KV_ID`. (Spør den om den skal legge det inn for deg, kan du svare ja, men sjekk at det bare står én `[[kv_namespaces]]`-blokk i filen etterpå.)

### 4. Fyll inn GitHub Pages-adressen

I `wrangler.toml`, endre:
```toml
ALLOWED_ORIGIN = "https://DITT_GITHUB_BRUKERNAVN.github.io"
```
Bare domenet. **Ikke** ta med reponavnet eller `/` på slutten. Dette bestemmer hvilken nettside som får lov å snakke med Workeren (CORS).

### 5. Publiser Workeren første gang

```powershell
npx wrangler deploy
```
Laster opp koden. Første gang ber Cloudflare deg kanskje velge et *workers.dev*-underdomene. Til slutt skrives adressen ut, f.eks.:

```
https://garasjeport.dittnavn.workers.dev
```
Noter den. Den trengs i trinn 8 og 9.

### 6. Lag to tilfeldige hemmeligheter

Kjør denne **to ganger**:
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Den skriver ut en lang tilfeldig streng. Bruk den første som **WEBHOOK_SECRET** (TTN → Worker) og den andre som **APP_TOKEN** (din «nøkkel» til appen). Lagre begge i passordbehandleren din.

### 7. Lag API-nøkkel i TTN

1. Gå til <https://eu1.cloud.thethings.network/console> → *Applications* → `garasjeport-hellargata` → *API keys* → **+ Add API key**.
2. Navn: `cf-worker`. Velg *Grant individual rights* og kryss av **Write downlink application traffic**. Ingenting annet.
3. Trykk *Create API key* og **kopier nøkkelen med en gang**. TTN viser den bare én gang. Den starter med `NNSXS.`.

### 8. Legg hemmelighetene inn i Workeren

Kjør hver kommando og lim inn verdien når du blir spurt (det du limer inn vises ikke):

```powershell
npx wrangler secret put TTN_API_KEY
```
```powershell
npx wrangler secret put WEBHOOK_SECRET
```
```powershell
npx wrangler secret put APP_TOKEN
```
Verdiene lagres kryptert hos Cloudflare og havner aldri i koden eller i GitHub.

### 9. Sett opp webhook i TTN

I TTN-konsollen: `garasjeport-hellargata` → *Integrations* → *Webhooks* → **+ Add webhook** → **Custom webhook**.

| Felt | Verdi |
|---|---|
| Webhook ID | `cf-worker` (må være nøyaktig dette, det inngår i downlink-adressen) |
| Webhook format | JSON |
| Base URL | Worker-adressen fra trinn 5, uten `/` til slutt |
| Additional headers | Navn `X-Webhook-Secret`, verdi = WEBHOOK_SECRET fra trinn 6 |
| Enabled event types | Kryss av **Uplink message** med sti `/ttn/uplink`, og **Downlink queued**, **Downlink sent** og **Downlink failed** med sti `/ttn/downlink`. Ikke noe annet. |

Trykk *Add webhook*.

Sjekk også: *End devices* → `garasjeport-node` → *Payload formatters* → *Downlink* → **None** → *Save changes*.

### 10. Test at Workeren mottar data

Vent på neste periodiske uplink (maks ca. 10 min), eller flytt magneten ved en av reed-bryterne. Kjør så (bytt inn din adresse og ditt APP_TOKEN):

```powershell
curl.exe -H "Authorization: Bearer DITT_APP_TOKEN" https://garasjeport.dittnavn.workers.dev/api/status
```
Skriv `curl.exe`, ikke `curl`. I PowerShell er `curl` noe annet. Du skal få tilbake JSON med `"status":"closed"` (eller `open`).

Vil du se hva Workeren gjør i sanntid:
```powershell
npx wrangler tail
```
Viser logg for hvert kall til Workeren. Avslutt med `Ctrl+C`.

### 11. Legg koden på GitHub

1. Gå til <https://github.com/new>. Navn f.eks. `garasjeport`. Velg gjerne **Private** (Pages fungerer med privat repo når du har Pro). Ikke huk av for README eller .gitignore. Trykk *Create repository*.
2. Åpne `docs/config.js` og sett inn Worker-adressen fra trinn 5.
3. Kjør i prosjektmappen (bytt `DITTNAVN`):

```powershell
git init -b main
```
Gjør mappen til et git-repo med hovedgrenen `main`.

```powershell
git add .
```
Legger alle filer klar til commit. `.gitignore` sørger for at `node_modules` og `.dev.vars` blir utelatt.

```powershell
git commit -m "Første versjon av garasjeport-appen"
```
Lagrer en versjon lokalt.

```powershell
git remote add origin https://github.com/DITTNAVN/garasjeport.git
```
Forteller git hvor repoet på GitHub ligger.

```powershell
git push -u origin main
```
Laster opp. Første gang åpnes et innloggingsvindu for GitHub.

### 12. Slå på GitHub Pages

1. På GitHub: repoet → *Settings* → *Pages*.
2. *Source*: **Deploy from a branch**. *Branch*: `main`, mappe **/docs**. *Save*.
3. Etter ett til to minutter vises adressen, f.eks. `https://dittnavn.github.io/garasjeport/`.

### 13. Ta appen i bruk

Åpne Pages-adressen på mobilen, lim inn **APP_TOKEN** og trykk *Lagre*. Tokenet lagres bare i den nettleseren. Legg gjerne siden til på hjemskjermen (Safari: Del → *Legg til på Hjem-skjerm*; Chrome: ⋮ → *Legg til på startskjermen*).

---

## Endre innstillinger senere

Alle innstillingene ligger under `[vars]` i `wrangler.toml`. Etter en endring kjører du `npx wrangler deploy` på nytt.

| Innstilling | Betydning |
|---|---|
| `CLOSED_SENSOR` | `DI1` eller `DI2`, altså hvilken reed-bryter som sitter ved lukket port. Den andre blir «åpen». Bytt hvis appen viser Åpen når porten er lukket. |
| `PULSE_PAYLOAD` | Pulslengde: `BQEQA+g=` = 1 s, `BQEQAfQ=` = 0,5 s, `BQEQB9A=` = 2 s |
| `PULSE_DAILY_LIMIT` | Maks relépulser per døgn (norsk tid) før kommandoer sperres. Standard 20. Bekreftelser (ACK) for confirmed uplinks teller ikke. |
| `PULSE_MIN_INTERVAL_SECONDS` | Minste tid mellom to kommandoer. Standard 15. |
| `STALE_MINUTES` | Etter så mange minutter uten statuspakke vises «Ukjent». Standard 30. |

Endringer i frontenden (`docs/`) publiseres ved å committe og pushe:
```powershell
git add .
```
```powershell
git commit -m "Beskriv endringen"
```
```powershell
git push
```

## Hvordan appen oppfører seg

- **Statuspakker** (MOD1, `Work_mode = 2ACI+2AVI`) er fasit for status.
- **Trigger-pakker** (MOD6, `Exit mode`) kommer ca. 7 s før statuspakken. I dem betyr `DIx_status = True` hvilken bryter som utløste triggeren (ikke bryterverdien). Sammen med statusen før gir det: *Lukket* + lukket-bryter → **Åpner**, *Åpen* + åpen-bryter → **Lukker**, og under kjøring → **Åpen**/**Lukket**. Slik status vises som «Foreløpig» til statuspakken bekrefter eller retter den. Retningen glemmes etter 60 s uten ny trigger, eller hvis det sendes en ny puls underveis (porten kan ha stoppet).
- **Én knapp:** *Åpne* når porten er lukket, *Lukk* når den er åpen. Mens porten åpner eller lukker, er den en grå *Send puls (stopp/snu) …*. Har porten stoppet midtveis, eller er status feil eller ukjent, blir den en rød *Send manuell puls …*.
- Alt krever bekreftelse i et eget vindu med advarselen om fri bane (ingen fotocelle).
- **Foreløpig status** (kommando sendt, eller tolket fra trigger) vises blek med stiplet kant. **Bekreftet** status (fra statuspakke) vises i full farge med heltrukken kant.
- **Prikken** i statuskortet viser om systemet lever: grønn = melding fra noden siste 15 min, gul = 15–30 min, rød = over 30 min eller ingen kontakt med Workeren. Den blinker når en ny melding kommer, og viser klokkeslettet når du trykker på den.
- Sensorer, signal, tellere og historikk ligger under *Detaljer*. Mens noe skjer, oppdateres appen hvert 2. sekund, ellers hvert 5.
- Reagerer ikke porten innen 20 s etter en kommando, låses knappen opp igjen og appen sier fra («Porten reagerte ikke …»). Kommandoer sendes med TTNs `down/replace`, så en ny kommando erstatter en som fortsatt ligger i kø, og porten kan ikke få to pulser.
- TTNs meldinger om downlinks (lagt i kø, sendt fra gateway, feilet) logges i historikken, og appen nevner dem når en kommando ikke gir reaksjon.
- **Workers Logs** er slått på: Cloudflare-dashbordet → Workers & Pages → garasjeport → *Logs* viser hver uplink, kommando og downlink-hendelse.
- Workeren teller relépulser per døgn. Ved 20 sperres kommandoer til midnatt. I tillegg vises totalt antall downlinks (relépulser + bekreftelser TTN sender for confirmed trigger-pakker), men det tallet sperrer ingenting.
- Status- og kommandoendringer logges i historikken, sammen med alle trigger-pakker (som appen skjuler). Siste 300 oppføringer.

## Sikkerhet

- `TTN_API_KEY`, `WEBHOOK_SECRET` og `APP_TOKEN` finnes bare som Cloudflare-secrets. Skulle et av dem lekke: lag en ny verdi og kjør `npx wrangler secret put ...` igjen. For TTN-nøkkelen: slett den gamle under *API keys* i TTN.
- GitHub Pages-siden er offentlig. Den inneholder ingen hemmeligheter, og uten APP_TOKEN gjør den ingenting.
- Sterkere alternativ senere: **Cloudflare Access** foran Workeren (gratis for opptil 50 brukere) gir innlogging med e-postkode.
- **Fotocelle er ikke montert.** Se alltid etter at porten har fri bane.

## Lokal testing (valgfritt)

```powershell
copy .dev.vars.example .dev.vars
```
Lager en fil med testverdier for hemmeligheter. Den commites aldri.

```powershell
npm run dev
```
Kjører Workeren lokalt på `http://localhost:8787` med egen, tom testlagring. Merk at downlinks da går til ekte TTN med en ugyldig nøkkel og blir avvist. Det er meningen.

Får du feilen `SQLITE_CANTOPEN`, ligger prosjektmappen for dypt for Windows. Kjør i stedet:
```powershell
npx wrangler dev --persist-to C:\temp\garasjeport-dev
```

## Fase 2 (ikke laget ennå)

- Varsel når porten har stått åpen lenger enn X minutter: Cron Trigger i Workeren + ntfy.sh eller e-post.
- Grafisk historikk over åpninger.
