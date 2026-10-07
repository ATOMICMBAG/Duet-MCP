# duet-mcp

MCP-Server (Model Context Protocol), mit dem Claude Code eine **Duet-Maschine (RepRapFirmware)** über LAN/WLAN bedienen kann:
Status lesen, Dateien verwalten, Kamerabilder ansehen, Achsen referenzieren, Drucke starten und überwachen. Der Server wirkt als Sicherheitsschicht zwischen Claude und der Maschine.

> **Sicherheit zuerst:** Heizungen und Motoren sind gefährlich. Alpha-Software ohne Gewährleistung, nie unbeaufsichtigt betreiben, Notaus in Reichweite halten. Bitte lies [SAFETY.md](SAFETY.md) vor der ersten Benutzung. / *Heaters and motors are dangerous. Alpha software, no warranty, never run unattended. Read [SAFETY.md](SAFETY.md) first.*
>
> **Repository:** https://github.com/ATOMICMBAG/Duet3D-MCP (privat).
>
> **Lizenz:** noch nicht festgelegt (`UNLICENSED` in `package.json`, siehe Schritt B7). Bis dahin ist das Repository privat.
>
> **Inoffizielles Community-Projekt.** Nicht von Duet3D. Der Name `duet-mcp` bewusst ohne Firmenmarke.
>
> **Status: Alpha.** Getestet ist bisher nur eine **Duet 2 WiFi** mit **RepRapFirmware 3.2.x** (Standalone), kartesischer Drucker. Heizungen und Motoren sind gefährlich: nie unbeaufsichtigt betreiben, Notaus in Reichweite halten. Siehe [SAFETY_RULES.md](SAFETY_RULES.md).

```
Handy / PC ──► Claude Code ──► duet-mcp (lokal, stdio) ──► Duet (HTTP, LAN/WLAN)
                                   └──► Kamera (HTTP / RTSP / lokale Webcam)
```

## Schnellstart

```bash
npm install
npm run build
```

`.env` anlegen (Vorlage: [.env.example](.env.example), die Datei ist git-ignoriert):

```
DUET_HOST=192.168.x.x
DUET_PASSWORD=<dein DWC-Passwort>
DUET_READ_ONLY=true
```

Bei Claude Code registrieren:

```bash
claude mcp add duet -- node "<Pfad>/dist/index.js"
```

**Standard ist Nur-Lesen.** Steuerwerkzeuge gibt es erst mit `DUET_READ_ONLY=false`.

## Einstellungen (Umgebung oder `.env`)

| Variable | Bedeutung | Standard |
|---|---|---|
| `DUET_HOST` | IP oder Hostname der Duet | erforderlich |
| `DUET_PASSWORD` | DWC-Passwort | `reprap` |
| `DUET_READ_ONLY` | `false` schaltet Steuerwerkzeuge frei | `true` |
| `DUET_CAMERA_URL`, `DUET_CAMERAS` | Kameras: `name=url,...`; `http(s)://` (Foto oder MJPEG), `rtsp://`, `dshow:<Gerät>` | keine |
| `DUET_MACROS` | Erlaubte Makros für `M98`, kommagetrennt | keine |
| `DUET_MAX_BED_TEMP`, `DUET_MAX_TOOL_TEMP` | Obergrenzen in `send_gcode` | 100 / 260 |
| `DUET_HEAT_IDLE_MINUTES` | Heizungs-Wächter, 0 = aus | 15 |
| `DUET_AUDIT_LOG` | Pfad des Audit-Logs | `duet-mcp-audit.log` |
| `FFMPEG_PATH` | Pfad zu `ffmpeg` (für RTSP und lokale Webcam) | `ffmpeg` im PATH |

## Werkzeuge (Stand heute)

Dazu **5 Prompts** (Ablaufvorlagen) und **4 Resources** (Profil, `config.g`, Einstellungen, Ereignisse), siehe B5.
Lesen: `get_status`, `get_machine_profile`, `get_machine_info`, `get_sensors`, `list_files`, `read_file` (Passwörter geschwärzt), `get_endstops`, `get_camera_snapshot`, `list_local_cameras`, `preflight_gcode`, `job_status`, `emergency_stop`.
Steuern (nur mit `DUET_READ_ONLY=false`): `send_gcode` (mit Guard), `home_axes`, `start_job`, `pause_job`, `resume_job`, `cancel_job`, `upload_file`, `set_speed_profile`.

## Kompatibilität

Ehrlicher Stand: **Getestet ist nur eine Duet 2 WiFi mit RepRapFirmware 3.2.2 (Standalone, kartesischer Drucker).** Alles andere ist aus der dokumentierten HTTP-Schnittstelle und dem offiziellen Connector (`@duet3d/connectors`) abgeleitet, aber nicht geprüft. Das Werkzeug `get_machine_info` zeigt, mit welchem Board und welcher Firmware der Server spricht und wie weit das geprüft ist; bei einer nicht unterstützten Kombination warnt der Server beim Start.

| Board | Firmware | Modus | Stand |
|---|---|---|---|
| Duet 2 WiFi | 3.2.x | Standalone | **getestet** |
| Duet 2 WiFi / Ethernet / Maestro | 3.0–3.6 | Standalone | erwartet kompatibel, ungetestet |
| Duet 3 Mini 5+, MB6HC, MB6XD (WiFi/Ethernet) | 3.3–3.6 | Standalone | erwartet kompatibel, ungetestet |
| Duet 3 mit Einplatinencomputer (Raspberry Pi) | beliebig | SBC (DuetWebServer) | **nicht unterstützt** (andere Schnittstelle, geplant) |
| beliebiges Board | 2.x | – | **nicht unterstützt** (kein Objektmodell), klare Fehlermeldung |

Was der Server dafür umsetzt: Sitzungsschlüssel (`rr_connect?sessionKey=yes`, Header `X-Session-Key`), damit DWC und der Server auf demselben PC keine Sitzung teilen; Prüfung der API-Stufe; Upload mit CRC32-Prüfsumme und Wiederholung bei Übertragungsfehlern; Erkennung des emulierten SBC-Modus (`isEmulated`). Der Sitzungsschlüssel ist auf der getesteten Firmware 3.2.2 nicht aktiv (sie liefert keinen), er ist nur mit der simulierten Duet getestet.

**Zusätzliche Sensoren und Zubehör** liest `get_sensors` (Sonden wie BLTouch, Filamentsensoren, analoge Temperatursensoren, Endstopps). An der getesteten Duet sind außer den drei Endstopps keine angeschlossen. Wer ein anderes Board oder Zubehör hat, ist eingeladen zu testen: bitte `get_machine_info` und `get_sensors` ausführen und das Ergebnis (ohne IP und Passwort) als Issue melden.

## Entwicklung

```bash
npm test          # Unit-Tests (ohne Hardware)
npm run build
npm run dev       # direkt aus src/ starten
```

---

# Plan (Schritt für Schritt)

Reihenfolge ist ein Vorschlag. Jeder Schritt hat eine **Abnahme**, damit man ihn abhaken oder streichen kann.
Legende: `[x]` erledigt, `[ ]` offen, `[?]` offene Entscheidung.

## Stand: bereits umgesetzt
- [x] Zugriff auf Duet (`rr_*`), Sitzung, Anfragen nacheinander (schont die Duet 2)
- [x] Maschinenprofil aus `config.g` plus Live-Werten der Firmware (Achsgrenzen, Heizungslimits, Kinematik)
- [x] Guard für `send_gcode` (gesperrt / bestätigungspflichtig / Grenzen), Details in `SAFETY_RULES.md`
- [x] Referenzieren: Z, X, Y; Freifahren vor dem Anfahren; Zeitüberschreitung löst `M112` aus
- [x] Kameras: HTTP, MJPEG, RTSP, lokale Webcam (`dshow:`)
- [x] Audit-Log, Heizungs-Wächter, `.env`, Passwort-Schwärzung, Fehlerantworten der Duet werden zu Fehlern
- [x] Tests (158), darunter End-to-End gegen eine simulierte Duet, plus ein echter Testlauf auf der Duet (siehe unten)

## A. Aus den Wegwerf-Skripten ins Produkt
- [x] **A0 Bekannte Fehler beheben.** `cancel_job` pausiert einen laufenden Job zuerst (`M25`), dann `M0` (die Firmware lehnt `M0` sonst ab); lässt die Heizziele unverändert. `resume_job` verweigert, wenn vor der ersten Schicht pausiert wurde oder eine Heizung nicht auf Temperatur ist (`resume.g` würde 10 mm in die Luft extrudieren), außer mit `force=true`. Code: `src/jobcontrol.ts`, Tests: `test/jobcontrol.test.ts`.
  *Abnahme (erfüllt):* Tests mit simulierter Duet (laufend, pausiert, idle, abgelehntes `M0`, kalte Düse).
  *Gegenprobe auf der echten Duet (07.10., Zustand `idle`, es wird nichts gesendet):* `cancel_job` meldet "nichts zu tun", `resume_job` verweigert ("nicht pausiert"). Erfüllt.
  *Echter Abbruch (07.10.):* `cancel_job` hat einen laufenden Druck auf der Duet in 2 Sekunden angehalten (Pause, dann `M0`, Zustand `idle`); die Heizziele blieben wie vorgesehen unverändert. Erfüllt.
- [x] **A1 G-Code-Vorprüfung (`preflight_gcode`)** (Grundversion). Liest eine lokale G-Code-Datei und meldet: Druckbereich gegen Achsgrenzen, Temperaturen gegen Limits, fehlende Werkzeugwahl (`T0`), `G28` im Start, Heizen vor dem Extrudieren, Heizungen am Ende aus, Firmware-/Konfigurationsbefehle in der Datei, Linienbreite gegen Düse, Lüfter, Filamentmenge, Zeit. Mit `fixes` (`select-tool`, `strip-g28`) entsteht eine Kopie `<name>.duet.gcode`; das Original bleibt unverändert. Code: `src/preflight.ts`, Tests: `test/preflight.test.ts`. Das Werkzeug ist auch im Nur-Lesen-Modus verfügbar (es schreibt nur lokal, nie zur Maschine).
  *Abnahme (Teil 1 erfüllt):* Findet bei der Beispieldatei `T0` und `G28`; die bereinigte Kopie ist `OK`; über MCP mit laufender Duet getestet.
  *Noch offen dazu:* Dateien aus PrusaSlicer und OrcaSlicer als Testbeispiele (bisher nur Cura und synthetische Dateien), Prüfung von Dateien direkt auf der SD-Karte, Bogenbewegungen (`G2`/`G3`) und Maximalgeschwindigkeit (`M203`), Zeitschätzung ohne Slicer-Angabe ist nur grob.
- [x] **A2 Drucküberwachung im Server.** Die Regeln laufen im Server, nicht im Chat (`src/supervisor.ts`, eingebunden in `src/index.ts`). Der Supervisor fragt die Duet ab (beim Drucken alle 10 s, im Leerlauf alle 30 s) und prüft:
  - **Übertemperatur** und **Durchgehen** der Heizung (auch ohne Job): Heizungen aus, bei laufendem Job zusätzlich Pause
  - **Heizungsfehler** der Firmware: Heizungen aus und Pause
  - **Temperaturabweichung** nach dem Einpendeln (Düse 15 °C, Bett 10 °C, länger als 45 s): Pause. Beim Aufheizen oder nach einem neuen Ziel zählt nichts als Abweichung
  - **Aufheiz-Zeitüberschreitung** (Ziel in 8 min nicht erreicht): Pause
  - **Kein Fortschritt** (180 s, nur wenn nichts heizt): Meldung, auf Wunsch Pause (`DUET_STALL_ACTION=pause`)
  - **Job-Ereignisse:** gestartet, pausiert, fortgesetzt, beendet, zu früh beendet (Abbruch, Reset oder Fehler), Maschine gestoppt
  - **Verbindung:** Passwort abgelehnt (sofort), Verbindung verloren (nach 60 s), wiederhergestellt. Ein laufender Druck läuft dann unbeaufsichtigt weiter, der Server kann in dem Moment nichts tun.
  Meldungen gehen an das Audit-Log, an stderr, als MCP-Logging-Benachrichtigung und in das neue Werkzeug `job_status`. Ohne `DUET_READ_ONLY=false` **beobachtet und meldet der Supervisor nur**, er sendet nie einen Befehl. Der Heizungs-Wächter (Leerlauf) ist jetzt Teil desselben Ablaufs. Alle Schwellen stehen in `.env.example`.
  *Abnahme (erfüllt):* 16 Regel-Tests mit simulierten Messreihen, darunter der Fehlalarm beim Aufheizen vom ersten Druck; 4 End-to-End-Tests mit einer simulierten Duet (`test/helpers/mockDuet.ts`): Pause bei Abweichung, Heizungen aus bei Übertemperatur, nur Meldungen im Nur-Lesen-Modus, Ruhe im Leerlauf; auf der echten Duet im Leerlauf geprüft (Rollen Bett/Düse erkannt, keine Befehle gesendet).
  *Echter Test (07.10., siehe unten):* Pause durch eine Regel auf der echten Duet, Meldungen im Druck, Abbruch aus der Pause. Dabei fand der Test eine Lücke (ein Abbruch aus der Pause wurde nicht als "Job zu früh beendet" gemeldet), die behoben und erneut real geprüft wurde.
  *Noch offen dazu:* Verhalten bei Duet-Neustart mitten im Job, Anzeige der MCP-Benachrichtigungen in Claude Code prüfen. Erkennung von klemmendem Filament bleibt unmöglich ohne Filamentsensor (siehe C).
- [x] **A3 Geschwindigkeitsstufen pro Schicht** (`src/speedprofile.ts`). Profil z. B. `1:30,2:50,3:80,6:100` (ab Schicht N, N % per `M220`; Schicht 1 ist die erste), gesetzt über `DUET_SPEED_PROFILE` oder das Werkzeug `set_speed_profile`. Der Server sendet `M220` nur, wenn eine Stufe erreicht wird; eine von Hand in DWC geänderte Geschwindigkeit bleibt bis zur nächsten Stufe unberührt. Nach Jobende setzt er einen von ihm gesetzten Faktor auf 100 % zurück. Werte außerhalb 10-150 % werden abgelehnt. Im Nur-Lesen-Modus nur Meldung. `job_status` zeigt Faktor und Profil.
  Beim Start sendet `start_job` die erste Stufe schon **vor** dem Job (`M220 S30` vor `M32`). Der echte Test zeigte nämlich, dass die Duet `M220` erst nach dem Aufheizen (`M109`) ausführt; die ersten Anfahrbewegungen liefen sonst kurz mit 100 %.
  *Abnahme (erfüllt):* 14 Tests der Regeln; 4 End-to-End-Tests mit simulierter Duet (Stufen, Zurücksetzen, Werkzeug mitten im Job, Nur-Lesen, erste Stufe vor dem Start); echter Druck mit Profil auf der Duet: Schicht 2 mit 50 %, Schicht 3-5 mit 80 %, ab Schicht 6 mit 100 %, danach wieder 100 % (siehe unten).
- [x] **A4 Wiederverbinden** (`src/duet.ts`, `src/supervisor.ts`). Der Client unterscheidet Fehlerarten (`DuetError`: Passwort abgelehnt, keine freie Sitzung, nicht erreichbar, Sitzung abgelaufen, Befehl abgelehnt) und meldet jede mit einer verständlichen Erklärung und dem Hinweis, was zu tun ist. Wiederholungsregeln:
  - **Sitzung abgelaufen (HTTP 401):** neu verbinden und **einmal** wiederholen. Die Duet hat den Befehl dann nicht ausgeführt, das ist für alle Aufrufe sicher. (Die Sitzung der Duet läuft nach 8 s Ruhe ab, das passiert im Alltag ständig.)
  - **Nicht erreichbar oder keine freie Sitzung:** nur **Lesebefehle** werden mit wachsender Wartezeit wiederholt. Befehle und Uploads werden **nie** wiederholt, weil nach einem Timeout unklar ist, ob die Duet sie schon ausgeführt hat.
  - **Falsches Passwort und abgelehnte Befehle:** endgültig, sofort gemeldet; ein abgelehnter Befehl verwirft die Sitzung nicht.
  Der Supervisor erkennt einen **Neustart der Duet** an der Betriebszeit (`state.upTime` fällt zurück), meldet "Duet neu gestartet" (Heizungen aus, Achsen nicht referenziert, ein laufender Job ist weg, evtl. `resurrect.g`), wartet bei anhaltendem Ausfall länger zwischen den Versuchen (bis 1 Minute) und meldet sich beim Beenden von der Duet ab (sie hat nur wenige Sitzungen). `job_status` erklärt auch dann, **warum** die Duet nicht lesbar ist, und zeigt die letzten Ereignisse.
  *Abnahme (erfüllt):* 9 Client-Tests gegen die simulierte Duet (Sitzung abgelaufen, Passwortwechsel und Wiederherstellung, keine freie Sitzung, nicht erreichbar, Befehl wird nach Verbindungsfehler nicht wiederholt, abgelehnter Befehl behält die Sitzung); 3 Supervisor-Tests und 3 End-to-End-Tests (Sitzungsablauf ohne Ereignis, Passwortfehler mit Erklärung und Wiederherstellung, Neustart der Duet); auf der echten Duet nach 20 s Ruhe fehlerfrei.
  *Noch offen dazu:* Ein echter Neustart der Duet während eines Jobs (nicht ohne Weiteres gefahrlos auslösbar) und ein bewusst falsches Passwort an der echten Duet wurden nicht ausprobiert, nur an der Simulation.

## B. Für eine gute Veröffentlichung
- [x] **B1 Echte Bestätigung** (`src/confirm.ts`, `src/guard.ts`, `src/index.ts`). Das `confirm=true` des Modells zählt nicht mehr. Der Server fragt den Menschen selbst, in dieser Reihenfolge (`DUET_CONFIRM=auto`):
  1. **MCP-Elicitation:** Der Client zeigt dem Nutzer die Frage (laut Dokumentation von Claude Code unterstützt; der Aufruf wartet, solange der Dialog offen ist).
  2. **Systemdialog** auf dem PC, auf dem der Server läuft (Windows getestet; macOS und Linux sind eingebaut, aber **ungetestet**). Standardantwort ist Nein, nach 120 s ebenfalls (`DUET_CONFIRM_TIMEOUT`).
  3. Sonst **Ablehnung** mit Erklärung. Weitere Modi: `elicit`, `dialog`, `deny` (gesperrt) und `model` (vertraut dem Flag des Modells, ausdrücklich unsicher, nur für Umgebungen ohne jede Rückfragemöglichkeit).
  **Gefragt wird** bei `start_job` (immer), `home_axes` (immer), `send_gcode` (Heizen, Referenzieren, `M500`/`M502`/`M999`, große Relativfahrten, `G1 H…`; alle Gründe in **einer** Frage mit dem G-Code) und `resume_job` mit `force`. **Nie** gefragt wird bei den Lesewerkzeugen, `pause_job`, `cancel_job`, `emergency_stop` und Befehlen, die ohnehin ungefährlich sind. Harte Sperren (Konfiguration, Firmware, Grenzen) bleiben auch mit Zustimmung gesperrt. Jede Antwort steht im Audit-Log.
  Zusätzlich tragen alle Werkzeuge **Hinweise** für Clients (`readOnlyHint`, `destructiveHint`). Sie sind nur ein Zusatz; ob Claude Code sie für eigene Rückfragen nutzt, ist nicht belegt.
  *Abnahme (erfüllt):* 8 Tests der Bestätigungslogik; 12 End-to-End-Tests (Frage zeigt G-Code und Grund, Ablehnung sendet nichts, `confirm=true` des Modells wird ignoriert, Client ohne Elicitation wird abgewiesen mit Erklärung, `model`- und `deny`-Modus, `start_job` und `home_axes` fragen, Notaus und Lesewerkzeuge nie, Hinweise pro Werkzeug); echter Windows-Dialog getestet (Ja wird zu Ja, Nein zu Nein).
  *Noch offen dazu:* Ein echter Ablauf in Claude Code (CLI und Desktop) mit dem Elicitation-Dialog; macOS- und Linux-Dialog; Verhalten, wenn Claude Code den Elicitation-Aufruf für Hintergrund-Aufgaben anders behandelt.
- [x] **B2 Mock-Duet und CI** (`test/helpers/mockDuet.ts`, `test/helpers/bootServer.ts`, `.github/workflows/ci.yml`). Die simulierte Duet spricht die `rr_*`-Endpunkte des Standalone-Modus: `rr_connect` (Passwort, keine freie Sitzung), `rr_model`, `rr_gcode`/`rr_reply`, `rr_filelist` (mit Seiten wie die Firmware), `rr_upload`, `rr_download`, `rr_disconnect`, Sitzungsablauf (401) und veränderbarer Zustand (Status, Heizungen, Job, Betriebszeit, Geschwindigkeitsfaktor). `bootServer()` startet den echten Server dagegen und verbindet einen MCP-Client, optional mit Elicitation. Damit kann jeder ohne Drucker testen. Die CI (GitHub Actions) baut und testet bei jedem Push und Pull Request auf Ubuntu und Windows mit Node 22 und 24; Systemdialoge sind dort abgeschaltet.
  *Abnahme:* `npm test` testet Homing, Jobs, Fehlerfälle, Wiederverbinden, Supervisor, Bestätigung, Geschwindigkeitsprofil und Dateien gegen den Mock (134 Tests, lokal grün). *Noch offen dazu:* Die CI muss nach dem ersten Push auf GitHub tatsächlich grün sein, das ist bisher nur lokal unter Windows mit Node 25 geprüft.
- [x] **B3 Versionsmatrix** (auf die verfügbaren Geräte begrenzt: Duet 2 und Duet 3 Standard-Boards; Community-Tests sind später willkommen). Tabelle und ehrliche Statusangabe stehen in der README ("Kompatibilität"), im Code `src/compat.ts` (Board- und Firmware-Erkennung, Werkzeug `get_machine_info`, Warnung beim Start). Der Client wurde nach dem offiziellen Connector um Sitzungsschlüssel, Prüfung der API-Stufe, CRC32-Upload mit Wiederholung und Erkennung des emulierten SBC-Modus ergänzt (`src/duet.ts`, `src/crc32.ts`). Neues Werkzeug `get_sensors` für Sonden, Filamentsensoren und analoge Sensoren.
  *Abnahme (erfüllt):* 19 neue Tests (Board-Erkennung, Sitzungsschlüssel, zwei Clients nebeneinander, API-Stufe 0, CRC-Wiederholung, beide Werkzeuge); auf der echten Duet 2 WiFi: Board als "getestet" erkannt, zweite Sitzung neben der ersten, Upload mit Prüfsumme akzeptiert (identische Größe).
  *Noch offen dazu:* Tests auf Duet 2 Ethernet/Maestro, Duet 3 und neuerer Firmware (Community); SBC-Modus über die REST-Schnittstelle (`@duet3d/connectors` RestConnector); ob die Firmware 3.2 den CRC wirklich prüft, ist nicht bewiesen (er wird gesendet und akzeptiert). `@duet3d/connectors` wurde wieder entfernt (wurde nie benutzt; der Server spricht die HTTP-API direkt, daher keine LGPL-Bindung).
- [x] **B4 Sicherheitstext ganz vorne** (`SAFETY.md`, Hinweis ganz oben in der README, zweisprachig in den Kernaussagen). Enthält Haftungsausschluss, Nur-Lesen als Standard, "nie unbeaufsichtigt", was der Server schützt und was er **nicht** erkennen kann (klemmendes Filament, Feuer, Ausfall des Servers, defekte Hardware), Voraussetzungen an die Hardware (Firmware-Schutz testen, Sicherung, Rauchmelder, Notaus), Betriebsregeln und den Meldeweg für Sicherheitslücken.
  *Noch offen dazu:* Gegenlesen durch eine zweite Person (am besten aus der Duet3D-Community), englische Gesamtfassung, Meldeweg konkret eintragen, sobald das Repository öffentlich ist.
- [x] **B5 Gute Tool-Beschreibungen, Prompts, Resources** (`src/prompts.ts`, `src/index.ts`).
  - **Anleitung beim Verbinden** (MCP-`instructions`): der sichere Ablauf in zehn Zeilen (erst `get_machine_info` und `job_status`, vor dem Druck `preflight_gcode`, Zustimmung gibt der Mensch, Verhalten bei Ereignissen, Notaus, Nur-Lesen).
  - **Kurze Antworten:** `get_status` und `get_endstops` liefern nur noch das Nötige (Heizungen mit Rolle, Achsen mit Position/Referenz/Grenzen, Job mit Fortschritt), an der Test-Duet 641 statt mehreren tausend Zeichen.
  - **Beschreibungen** mit Voraussetzungen und Folgeschritten; ein Test erzwingt Mindest- und Höchstlänge für jedes Werkzeug.
  - **Prompts** (Ablaufvorlagen, die der Nutzer wählt): `pre_print_check`, `start_print_supervised`, `first_layer_profile`, `bed_leveling_assistant`, `troubleshoot_connection`. Clients wie Claude Code bieten MCP-Prompts als Befehle an (auf diesem System nicht geprüft).
  - **Resources:** `duet://machine/profile`, `duet://machine/config.g` (Passwörter geschwärzt), `duet://server/settings`, `duet://events/recent`.
  *Abnahme (Teil 1 erfüllt):* 8 Tests: Die Texte nennen nur Werkzeuge, die es gibt; jedes Werkzeug hat eine brauchbare Beschreibung; Prompts, Argumente und Resources funktionieren über MCP; auf der echten Duet gegengeprüft.
  *Noch offen dazu:* Der eigentliche Praxistest, ob ein **frisches Claude** nur anhand von Anleitung und Beschreibungen den richtigen Ablauf findet (braucht einen echten Durchlauf in Claude Code ohne Vorwissen); Prompts in Claude Code aufrufen; englische Texte der Prompts sind für das Modell, die Titel für die Nutzer.
- [x] **B6 Repo-Hygiene** (Teil 1, vor dem Veröffentlichen zu wiederholen). Am 07.10. geprüft: Suche in allen versionierten Dateien nach der eigenen IP, dem DWC-Passwort, Benutzerpfaden, E-Mail-Adressen, Schlüsseln und Zugangsdaten-Mustern ist leer (einzige Fundstelle: die allgemeine Beispiel-IP `192.168.1.50` in einer Fehlermeldung). `.gitignore` schließt `.env`, G-Code, STL, Logs, Kamerabilder und Build-Ordner aus; `.env.example` hat nur Platzhalter; `.gitattributes` vereinheitlicht die Zeilenenden.
  **Zu entscheiden, bevor das Repository öffentlich wird:** In der Commit-Historie steht die Autoren-Adresse aus der Git-Einstellung (`user.email`). Sie wird mit dem Repository öffentlich sichtbar. Wer das nicht will, stellt in Git und GitHub auf die No-Reply-Adresse um (GitHub → Settings → Emails → "Keep my email addresses private") und schreibt die zwei bisherigen Commits einmal um, solange das Repository privat ist.
  *Noch offen dazu:* Wiederholung der Suche kurz vor dem Veröffentlichen, Beispiel-G-Code anonymisieren (es gibt noch keine), Prüfung der Pakete auf Lizenzen (zusammen mit B7).
- [ ] **B7 Lizenz und Absprache mit der Community.** `[?]` Vorbereitet (Teil 1, erledigt): `CONTRIBUTING.md` (jeder konstruktive Beitrag ist willkommen, Sicherheitsregeln für Beiträge), `CODE_OF_CONDUCT.md`, `SECURITY.md`, Issue-Vorlagen (Hardware-Testbericht, Fehler, Idee), PR-Vorlage, Entwurf des Forenbeitrags in `docs/forum-post-draft.md`; die ungenutzte Abhängigkeit `@duet3d/connectors` (LGPL-2.1) ist entfernt. Befund: Firmware und DWC stehen unter **GPL-3.0**; unser Server nutzt nur die dokumentierte HTTP-API und bindet keinen Duet3D-Code ein, jede Lizenz ist also möglich. Offen (entscheidet der Besitzer): Lizenz festlegen (`LICENSE` + `package.json`), Repo öffentlich machen, Forenbeitrag veröffentlichen, Rückmeldung einarbeiten.
  *Abnahme:* Lizenz festgelegt und begründet; Forenbeitrag veröffentlicht; Rückmeldung eingearbeitet.
- [ ] **B8 Verpacken.** npm-Paket (`npx duet-mcp`), `.mcpb` für Claude Desktop, Beispiel für `claude mcp add`, README auf Englisch und Deutsch, Changelog, Versionierung (SemVer).
  *Abnahme:* Frische Installation auf einem zweiten Rechner in unter 10 Minuten.


## Echter Test A0 + A2 + A3 (07.10.2026, Duet 2 WiFi, RRF 3.2, Würfel-Datei)
Der Server lief als eigener Prozess (`DUET_READ_ONLY=false`) und wurde nur über MCP bedient, wie später von Claude. Bett sauber, Notaus in Reichweite. Das Ergebnis steht auch im Audit-Log (`realtest-audit.log`, git-ignoriert).
- **Phase 1** (7 von 7): Aufheiz-Zeitlimit künstlich auf 18 s. Der Supervisor pausierte den Job nach 18 s von selbst. `resume_job` lehnte vor der ersten Schicht ab, `cancel_job` brach ab, Heizungen aus.
- **Phase 2** (14 von 15, danach behoben): Profil `1:30,2:50,3:80,6:100`. Schicht 2 lief mit 50 %, Schicht 3-5 mit 80 %, Schicht 6 und 7 mit 100 %. Pause, Fortsetzen und Abbruch mitten im Druck liefen. Keine Fehlalarme beim Aufheizen. Fehlgeschlagen war nur: Ein Abbruch aus der Pause wurde nicht als "Job zu früh beendet" gemeldet. Zusätzlich fiel auf, dass die erste Stufe erst nach dem Aufheizen griff.
- **Phase 3** (7 von 7): Nach den Korrekturen: Faktor 30 % unmittelbar nach dem Start, "Job zu früh beendet" nach Abbruch aus der Pause, Faktor danach wieder 100 %.
- **Zusatzbefund:** Beim Pausieren schreibt die Firmware `0:/sys/resurrect.g` (Antwort auf `M25`: "Resume state saved"). Die Datei **blieb nach dem Abbruch auf der SD**. Sie enthält die Datei (`M23`), die Dateiposition (`M26 S...`), Heizungs- und Lüfterwerte. Siehe C: Fortsetzen nach Neustart.

## C. Später / Ideen
- [ ] **Kamera-Filamentkontrolle.** Hinter dem Filament klebt jetzt ein blauer Streifen (Bett-Tape) an der Schrankwand, damit das weiße Filament im Bild gut sichtbar ist (Abriss, Verheddern, Rolle klemmt). Ein Werkzeug könnte regelmäßig ein Bild holen und prüfen lassen. Ersetzt keinen Filamentsensor, ergänzt ihn. Beleuchtung sitzt jetzt in der Druckkammer.
- [ ] **Druck nach Neustart oder Abbruch fortsetzen.** Die Firmware schreibt `0:/sys/resurrect.g` schon beim Pausieren und lässt sie nach dem Abbruch stehen (Befund vom 07.10.). Ein Werkzeug `resume_after_restart` könnte darauf aufbauen (Firmware-Funktion `M916`). Offen und vor einem Versuch zu klären: `resurrect-prologue.g` fehlt auf der SD (wird von `resurrect.g` aufgerufen; dort gehören Referenzieren und Aufheizen hin), was `resurrect.g` nach einem Job-Neustart oder Neustart der Duet noch enthält, und ob die Koordinaten nach erneutem Referenzieren stimmen. Voraussetzungen für ein sicheres Werkzeug: Teil unverändert auf dem Bett, gleiche Z-Referenz, Datei unverändert, Bestätigung des Menschen. **Pflicht-Hinweis an den Nutzer** (vor dem Fortsetzen anzeigen und bestätigen lassen): "Das gedruckte Teil darf sich seit der Pause nicht verändert haben (nicht entfernen, nicht verschieben, nicht lösen). Die Position des Druckkopfes darf sich geändert haben." Dieser Hinweis wird beim Test des Fortsetzens mit geprüft. Alternative ohne Firmware-Hilfe: neue G-Code-Datei aus dem Original ab Schicht N (Heizen, Referenzieren, Position setzen).
- [ ] Handy als zweite Kamera (Phone Link, Iriun, DroidCam, IP Webcam) und mehrere Blickwinkel
- [ ] HTTP-Betriebsart mit Token für Fernzugriff, nur über VPN (die Duet nie ins Internet)
- [ ] Serienproduktion: Auswurf per Makro-Allowlist, Erstteil-Freigabe, Stückzahllimit, Kamera-Prüfung pro Schicht
- [ ] Filamentsensor einbinden (`M591`) und im Server auswerten
- [ ] PID-Hilfe (`M303`) für die Düse als geführter Ablauf
- [ ] Tests mit CoreXY, Delta, Polar (Guard ist vorbereitet, aber ungetestet)
- [ ] CNC- und Lasermodus (`M453`), Werkzeugwechsel
- [ ] Mehrere Maschinen
- [ ] Separater Adapter für Bambu Lab im LAN-Modus (nur lesen), eigenes Projekt

## Offene Entscheidungen
- `[?]` Lizenz (siehe B7)
- `[?]` Reihenfolge der Schritte
- `[?]` Soll der Server später Aufträge in einer Warteschlange halten (Serienproduktion)?
