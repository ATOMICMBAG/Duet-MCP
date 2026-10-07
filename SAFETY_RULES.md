# Sicherheitsregeln des Duet3D-MCP-Servers

Die Firmware (RepRapFirmware) bleibt die erste Sicherheitsebene (Heizungs-Fehlerüberwachung, Endstopps, M208-Grenzen).
Dieser Server ist die zweite Ebene. Er ersetzt weder Notaus noch Aufsicht.

## Umgesetzt
| # | Regel | Wo |
|---|-------|----|
| 1 | Steuerwerkzeuge sind aus, solange `DUET_READ_ONLY` nicht `false` ist | `config.ts`, `index.ts` |
| 2 | `emergency_stop` (M112) ist immer verfügbar; M999 braucht `confirm=true` | `index.ts`, `guard.ts` |
| 3 | Konfigurations-, Firmware-, Netzwerk- und Limit-Befehle sind in `send_gcode` gesperrt (M208, M143, M906, M92, M997, M551 ...) | `guard.ts` |
| 4 | Heizen, G28/G29/G30/G32/G92, M500/M502, Relativfahrten >50 mm, `G1 H…` brauchen die **Zustimmung des Menschen**: Der Server fragt selbst (Elicitation oder Systemdialog), das `confirm`-Flag des Modells wird ignoriert. Dasselbe gilt für `start_job`, `home_axes` und `resume_job` mit `force` | `guard.ts`, `confirm.ts` |
| 5 | Temperaturlimits (Bett/Düse) gelten auch mit `confirm=true` | `guard.ts` |
| 6 | Absolute Fahrten werden gegen die Live-Achsgrenzen der Firmware geprüft | `guard.ts`, `profile.ts` |
| 7 | Absolute Fahrten auf nicht referenzierten Achsen werden abgelehnt | `guard.ts` |
| 8 | Makros nur aus der Allowlist `DUET_MACROS` | `guard.ts` |
| 9 | **Freifahren vor Referenzieren:** Ist ein Endstopp schon ausgelöst, fährt der Server zuerst 5 mm weg, prüft, dass er freigibt, und fährt erst dann hin. Bleibt er ausgelöst, wird nicht referenziert | `homing.ts` |
| 10 | Referenzieren nur im Zustand `idle`, eine Achse nach der anderen, danach Prüfung `homed` | `homing.ts` |
| 11 | Zeitüberschreitung beim Referenzieren löst M112 aus | `homing.ts` |
| 12 | `start_job` nur im Zustand `idle` und wenn alle Achsen referenziert sind | `index.ts` |
| 13 | Uploads nach `0:/sys` sind gesperrt | `index.ts` |
| 14 | Passwörter (M551, M587 ...) werden aus gelesenen Dateien geschwärzt | `profile.ts` |
| 15 | Audit-Log aller Steueraktionen (`duet-mcp-audit.log`, JSON pro Zeile) | `index.ts` |
| 16 | Anfragen laufen nacheinander (Duet 2 hat wenig RAM und wenige Sitzungen) | `duet.ts` |

| 17 | Homing-Reihenfolge Z, X, Y (Z zuerst, hebt den Kopf vom Bett) | `homing.ts` |
| 18 | Kinematik-bewusst: Die XYZ-Box wird nur bei cartesian/core* geprüft. Bei Delta, SCARA, Polar braucht jede absolute Bewegung `confirm=true` | `guard.ts`, `profile.ts` |
| 19 | Heizungs-Wächter: Heizziel an, Maschine `idle` und kein Job länger als `DUET_HEAT_IDLE_MINUTES` (Standard 15, 0 = aus), dann Ziele auf 0 und Eintrag im Audit-Log. Wirkt nur in die sichere Richtung | `watchdog.ts`, `index.ts` |
| 20 | Druck-Supervisor im Server: Übertemperatur und Durchgehen der Heizung (Heizungen aus, bei Job zusätzlich Pause), Heizungsfehler, Temperaturabweichung nach dem Einpendeln, Aufheiz-Zeitüberschreitung (Pause), Stillstand des Fortschritts (Meldung oder Pause) | `supervisor.ts`, `index.ts` |
| 21 | Der Supervisor sendet nur Befehle, wenn `DUET_READ_ONLY=false`. Sonst meldet er nur ("Aktion übersprungen") | `index.ts` |
| 22 | Ereignisse (auch Verbindungsverlust, abgelehntes Passwort, Job zu früh beendet) im Audit-Log und in `job_status` | `index.ts` |
| 23 | `cancel_job` pausiert zuerst; `resume_job` verweigert vor der ersten Schicht und bei kalter Düse; Antworten `Error` der Duet werden zu Fehlern | `jobcontrol.ts`, `duet.ts` |
| 24 | Geschwindigkeitsprofil nur zwischen 10 und 150 %; der Server setzt `M220` nur bei Stufenwechsel und stellt nach dem Job auf 100 % zurück, wenn er selbst gesetzt hat | `speedprofile.ts` |

## Geplant
- Rückfallebene, wenn der MCP-Server selbst nicht läuft (Claude beendet, PC aus): Die Duet druckt dann allein weiter. Das lässt sich nur in der Firmware lösen (Filamentsensor, Makros, Zeitlimits), nicht im Server.
- Vorfluge für Serienproduktion: Erstteil-Freigabe durch den Menschen, Stückzahllimit, Kamera-Check pro Layer.
- Vorbedingung für Heizen: Thermistor plausibel (kein Kurzschluss/Abriss), Temperatursprünge melden.
- Filament- und Extrusionsprüfung: sehr lange Einzelextrusionen ablehnen, Kaltextrusion der Firmware überlassen.
- Zustimmung "für die nächsten N Minuten" statt bei jeder Aktion (heute wird jedes Mal gefragt).
