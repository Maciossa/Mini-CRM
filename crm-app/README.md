# Mini CRM

Prosty CRM w stylu Pipedrive: **Deals** (tablica kanban), **Contacts** (lista kontaktów), **Activities** (zaplanowane akcje).

- Backend: Node.js + Express
- Baza danych: plik JSON (biblioteka `lowdb`) — proste, bez potrzeby konfigurowania zewnętrznej bazy
- Frontend: czysty HTML/CSS/JS (bez frameworka, bez kroku budowania)

## Funkcje

**Deals** — 6 kolumn: Nowy Lead, Do oddzwonienia, Spotkanie Umówione, Follow up (Po prezentacji), Sprzedaż, Stary Lead.
Karty klientów przeciągasz myszką między kolumnami. Przycisk „+ Nowy Lead” otwiera formularz (Imię, Nazwisko, Mail, Telefon, Preferencje). Każda karta ma przycisk „+ Akcja” do zaplanowania działania (nazwa + data) z tym klientem.

**Contacts** — pełna lista wszystkich kontaktów ze wszystkimi danymi, edycja i usuwanie.

**Activities** — lista wszystkich zaplanowanych akcji posortowana po dacie, z nazwą klienta i jego danymi, możliwość oznaczenia jako wykonane.

## Uruchomienie lokalnie

```bash
npm install
npm start
```

Aplikacja wystartuje na `http://localhost:3000`.

## Wdrożenie na Railway (krok po kroku)

1. **Wrzuć ten folder na GitHub** — utwórz nowe repozytorium i wypchnij do niego zawartość tego folderu (`git init`, `git add .`, `git commit -m "init"`, `git push`).
2. Wejdź na **[railway.app](https://railway.app)** i zaloguj się (możesz przez GitHub).
3. Kliknij **New Project → Deploy from GitHub repo** i wybierz swoje repozytorium.
4. Railway automatycznie wykryje aplikację Node.js (dzięki `package.json` i skryptowi `start`) i ją zbuduje. Nie musisz nic dodatkowo konfigurować.
5. Po zbudowaniu wejdź w zakładkę **Settings → Networking** i kliknij **Generate Domain** — dostaniesz publiczny adres typu `twoja-nazwa.up.railway.app`, pod którym Twój CRM będzie dostępny z dowolnej przeglądarki.
6. **Ważne — trwałość danych:** domyślnie plik `data/db.json` żyje na tym samym dysku co kontener, ale przy niektórych redeployach Railway może zresetować system plików. Aby dane (klienci, akcje) **zawsze przetrwały** redeploy, dodaj Volume:
   - W projekcie na Railway wejdź w zakładkę **Volumes** → **New Volume**.
   - Ustaw punkt montowania (mount path) np. na `/data`.
   - W zakładce **Variables** dodaj zmienną środowiskową: `DB_PATH=/data/db.json`.
   - Zrestartuj deployment (Redeploy) — od tej pory baza danych będzie zapisywana na trwałym dysku.
7. Gotowe — otwórz wygenerowany adres i korzystaj z CRM przez przeglądarkę (działa też na telefonie).

## Struktura projektu

```
crm-app/
├── server.js          # backend Express + API
├── package.json
├── public/             # frontend (serwowany statycznie)
│   ├── index.html
│   ├── style.css
│   └── app.js
└── data/
    └── db.json          # baza danych (tworzy się automatycznie)
```

## API (dla własnych rozszerzeń)

| Metoda | Endpoint | Opis |
|---|---|---|
| GET | `/api/stages` | lista 6 etapów |
| GET | `/api/clients` | lista wszystkich klientów |
| POST | `/api/clients` | dodaj klienta (imie, nazwisko, mail, telefon, preferencje, stage) |
| PUT | `/api/clients/:id` | edytuj klienta / zmień etap |
| DELETE | `/api/clients/:id` | usuń klienta (i jego akcje) |
| GET | `/api/activities` | lista wszystkich akcji (z danymi klienta) |
| POST | `/api/activities` | dodaj akcję (client_id, action_name, date, notes) |
| PUT | `/api/activities/:id` | edytuj akcję / oznacz jako wykonaną |
| DELETE | `/api/activities/:id` | usuń akcję |

## Możliwe rozszerzenia na później
- logowanie / wielu użytkowników
- eksport kontaktów do CSV
- powiadomienia mailowe o zbliżających się akcjach
- historia zmian etapu klienta
