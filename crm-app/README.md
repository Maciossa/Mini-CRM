# Mini CRM

Prosty CRM w stylu Pipedrive: **Deals** (tablica kanban), **Contacts** (lista kontaktów), **Activities** (zaplanowane akcje).

- Backend: Node.js + Express
- Baza danych: plik JSON (biblioteka `lowdb`) — proste, bez potrzeby konfigurowania zewnętrznej bazy
- Frontend: czysty HTML/CSS/JS (bez frameworka, bez kroku budowania)

## Funkcje

**Konto + Profile** — dostęp do CRM wymaga najpierw zalogowania się na **konto** (mail + hasło) — to jest prywatne i niewidoczne dla innych osób. Po zalogowaniu można stworzyć jeden lub więcej **profili** na tym koncie — każdy profil to osobne, w pełni odseparowane CRM (osobni klienci, akcje, ustawienia prowizji), bez podawania maila/hasła ponownie (to już jest przypisane do konta). Przy tworzeniu profilu podaje się: Imię i nazwisko, Pseudonim oraz **Rynek** (Pierwotny lub Wtórny) — w przyszłości każdy rynek będzie miał inne, dopasowane opcje. W aplikacji (zakładka „Profile") można w każdej chwili przełączyć się na inny profil tego samego konta bez ponownego logowania, albo wylogować się z konta całkowicie.

**Trwałość danych** — każda zmiana (nowy klient, przesunięcie na tablicy, nowa akcja) jest od razu zapisywana na dysku serwera. **Jeśli jednak dane znikają po jakimś czasie (np. po kolejnym wdrożeniu), to prawie zawsze oznacza, że hosting nie ma podłączonego trwałego dysku** — na Render.com nazywa się to **Disk** (na Railway: Volume) — bez tego platforma czyści system plików kontenera przy każdym redeployu/restarcie. Zobacz sekcję „Wdrożenie na Render.com" niżej — to jest krok, który trzeba wykonać ręcznie w panelu Render. Jako dodatkowe zabezpieczenie w zakładce **Settings** jest:
- baner ostrzegawczy, jeśli serwer wykryje, że Volume nie jest podłączony,
- przycisk „Pobierz kopię zapasową” (plik JSON ze wszystkimi Twoimi klientami i akcjami),
- przycisk „Przywróć z pliku” (wczytuje kopię z powrotem do systemu).

Rób kopię zapasową regularnie, dopóki nie skonfigurujesz Volume — to jedyny sposób, by nic nie stracić, jeśli backend zostanie zresetowany.

**Deals** — 8 kolumn: Nowy Lead, Do oddzwonienia, Spotkanie Umówione, Follow up (Po prezentacji), Rezerwacja Ustna, Rezerwacja Wstępna (1%), Sprzedaż, Stary Lead.
Karty klientów przeciągasz myszką między kolumnami. Przycisk „+ Nowy Lead” otwiera formularz (Imię, Nazwisko, Mail, Telefon, Preferencje). Każda karta ma przycisk „+ Akcja” do zaplanowania działania (nazwa + data) z tym klientem.

**Contacts** — pełna lista wszystkich kontaktów ze wszystkimi danymi (w tym Inwestycja i Cena nieruchomości), edycja i usuwanie.

**Activities** — lista wszystkich zaplanowanych akcji posortowana po dacie, z nazwą klienta i jego danymi, panel delikatnie podświetla się na czerwono od dnia wykonania akcji. Możliwość oznaczenia jako wykonane.

**Calendar** — kalendarz miesięczny do umawiania spotkań z klientami z bazy.

**Settings** — wybór podziału prowizji agenta (45% / 50% / 55% / 60%) oraz kopia zapasowa danych.

### Dane klienta: Inwestycja i kalkulator prowizji

Przy tworzeniu / edycji leada można podać:
- **Inwestycja** — dowolna nazwa (wyświetlana w danych klienta zaraz pod „Telefon”),
- **Cena nieruchomości** oraz **Prowizję (%)** — np. „1.6”.

Na tej podstawie w oknie szczegółów klienta automatycznie wyliczana jest prowizja do wypłaty, według wzoru:

1. `Kwota prowizji = Cena nieruchomości × Prowizja (%)`
2. `Udział agenta = Kwota prowizji × Podział prowizji agenta (z zakładki Settings)`
3. `Do wypłaty = Udział agenta − 15% podatku`

Zmiana podziału prowizji w Settings przelicza wynik dla wszystkich klientów na bieżąco (wynik nie jest „zamrożony” w momencie tworzenia leada).

## Uruchomienie lokalnie

```bash
npm install
npm start
```

Aplikacja wystartuje na `http://localhost:3000`.

## Wdrożenie na Render.com (krok po kroku)

1. **Wrzuć ten folder na GitHub** — utwórz nowe repozytorium i wypchnij do niego zawartość tego folderu (`git init`, `git add .`, `git commit -m "init"`, `git push`).
2. Wejdź na **[render.com](https://render.com)** i zaloguj się (możesz przez GitHub).
3. Kliknij **New → Web Service** i wybierz swoje repozytorium.
4. Ustaw:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Plan: wystarczy darmowy (Free) do testów, choć na darmowym planie usługa „usypia" po chwili nieaktywności i potem wolniej startuje.
5. Kliknij **Create Web Service** — Render zbuduje i uruchomi aplikację, a po chwili dostaniesz publiczny adres typu `twoja-nazwa.onrender.com`, pod którym CRM będzie dostępny z dowolnej przeglądarki.
6. **Ważne — trwałość danych:** tak jak w większości platform kontenerowych, domyślny system plików na Render jest **efemeryczny** — przy każdym redeployu (np. po push do GitHub) dysk jest czyszczony i plik `data/db.json` znika razem z całą bazą. Żeby dane **zawsze przetrwały** redeploy, dodaj trwały dysk (Render **Disk**):
   - W ustawieniach usługi wejdź w zakładkę **Disks** → **Add Disk**.
   - Podaj np. nazwę `crm-data`, rozmiar 1 GB wystarczy, **Mount Path:** `/data`.
   - W zakładce **Environment** dodaj zmienną środowiskową: `DB_PATH=/data/db.json`.
   - Zapisz — Render automatycznie zredeployuje usługę z podłączonym dyskiem. Od tej pory baza danych będzie zapisywana na trwałym dysku i przetrwa kolejne wdrożenia.
7. Gotowe — otwórz wygenerowany adres i korzystaj z CRM przez przeglądarkę (działa też na telefonie).

Jako dodatkowe zabezpieczenie (na wypadek gdybyś zapomniał dodać dysk, albo chciał mieć kopię „na wszelki wypadek") w zakładce **Settings** w aplikacji jest przycisk „Pobierz kopię zapasową" i „Przywróć z pliku" — patrz sekcja „Trwałość danych" niżej.

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
| GET | `/api/session` | konto + aktualnie wybrany profil (jeśli jest) |
| POST | `/api/account/register` | rejestracja konta (mail, password) |
| POST | `/api/account/login` | logowanie na konto (mail, password) |
| POST | `/api/account/logout` | wylogowanie z konta |
| GET | `/api/profiles/markets` | lista dostępnych rynków (pierwotny/wtorny) |
| GET | `/api/profiles` | lista profili NA TYM koncie (id, pseudonim, rynek) |
| POST | `/api/profiles` | stwórz profil (imie_nazwisko, pseudonim, rynek) |
| POST | `/api/profiles/:id/select` | wejdź do profilu (bez hasła — konto już zalogowane) |
| GET | `/api/profiles/me` | dane aktywnego profilu |
| PUT | `/api/profiles/me/settings` | ustaw podział prowizji agenta (45/50/55/60) |
| GET | `/api/system/status` | czy baza jest na trwałym dysku (Disk) |
| GET | `/api/backup/export` | pobierz kopię zapasową profilu (klienci + akcje) |
| POST | `/api/backup/import` | przywróć dane do profilu z kopii zapasowej |
| GET | `/api/stages` | lista 8 etapów |
| GET | `/api/clients` | lista wszystkich klientów aktywnego profilu |
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
