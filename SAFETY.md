# Safety / Sicherheit

**Please read first. / Bitte zuerst lesen.**

*[Deutsche Fassung weiter unten](#sicherheit-deutsch).*

# Safety (English)

## Disclaimer

duet-mcp lets an AI assistant operate a machine with **heaters and motors**. Heaters can start fires, motors can injure people and damage the machine.

- This is **alpha software, provided as is, without any warranty** (see [LICENSE](LICENSE)). You use it at your own risk.
- It is an unofficial community project and **not affiliated with Duet3D**.
- **Never leave a machine running unattended**, with or without this software. Keep the emergency stop and the power switch within reach.
- Use it only in a **trusted local network**. The Duet speaks plain HTTP without encryption. Never expose the Duet or this server to the internet; use a VPN if you need remote access.

## What the server protects (second layer)

The first layer stays the firmware (RepRapFirmware): temperature limits (`M143`), heater fault monitoring, axis limits (`M208`), endstops. The server checks additionally, and earlier. The full list of numbered rules is in [SAFETY_RULES.md](SAFETY_RULES.md). German: [SAFETY_RULES.de.md](SAFETY_RULES.de.md). In short:

- **Read-only by default.** Control tools do not exist until you set `DUET_READ_ONLY=false`.
- **Human approval** for starting a print, homing, heating and other risky commands. The server asks the question itself (MCP elicitation or a system dialog). The AI cannot approve for you, and the model's own `confirm` flag is ignored.
- **Hard blocks** for configuration, firmware, network and limit changes, even with approval. These are done by you in `config.g`.
- **Limits before sending:** temperatures, build volume (taken from your `config.g`), axes that are not homed, a macro allowlist.
- **G-code pre-flight check** (`preflight_gcode`) before the upload.
- **Supervision inside the server** (not in the chat): over-temperature, temperature deviation, heat-up timeout, stalled progress, Duet restart, lost connection. It pauses the job or switches heaters off, but only with `DUET_READ_ONLY=false`.
- **Idle-heater watchdog:** heaters that stay on without a job are switched off after `DUET_HEAT_IDLE_MINUTES` (default 15).
- **Homing** moves Z first, backs off before approaching an endstop and stops the machine (`M112`) on a timeout.
- **Audit log** of every command that was sent, blocked or declined.
- **Emergency stop** (`emergency_stop`, `M112`) is always available and is never questioned.

## What the server cannot detect

- **Jammed or broken filament**, a clogged nozzle, a part coming loose. The Duet does not measure the feed. Only a filament monitor or your own eyes on the camera help.
- **Fire or smoke.** A camera is not a safety device.
- **Failure of the server, the PC or the network.** If the MCP server is not running, the Duet keeps printing on its own without its supervision. The machine must be built so that this is harmless even without this software.
- **Defective hardware** that the firmware does not notice (for example a wrongly mounted thermistor, so the heater block is measured too cold). The server polls only every 10 seconds.
- **A wrong or manipulated AI.** The checks are rules in code, not judgment. A model can misunderstand a request; that is why risky steps need your approval and why you must read each question.
- **Bugs in this software.** It is alpha. It has so far only been tested on a Duet 2 WiFi with RepRapFirmware 3.2 and a Cartesian printer. Other boards, firmware versions and kinematics (CoreXY, Delta, Polar) are untested.

## Requirements for your hardware

Before you use the server with control enabled, check yourself:

- The **firmware protections** are active and tested: maximum temperature per heater (`M143`), heater fault monitoring, thermistor connection. Test unplugging a thermistor **without** this software.
- **Power supply and wiring** are adequate, heater wires are firmly seated, and there is a suitable **fuse**.
- A **smoke detector** near the machine, a **fire extinguisher** within reach, flammable material kept away.
- An **emergency stop** or a power switch you can reach without thinking. Optionally a switchable socket.
- The **camera** (if used) has enough light. In the dark you see nothing.

## Operating rules

1. Start **read-only** (`DUET_READ_ONLY=true`) and check status, profile and endstops.
2. Test movements **without heating and without material**, with a hand on the emergency stop.
3. Run the **first print with control enabled** next to the machine without leaving. Afterwards you know how the system behaves.
4. Check the **bed before every start** (empty, clean, correctly set up).
5. **Answer the questions consciously.** If a question is not clear to you, decline.
6. Do not leave **any heater on unattended**. The idle watchdog is a safety net, not a replacement.
7. Keep the **DWC password** in `.env` (never in the repository, never in the chat) and set one on the Duet.
8. **Local network only.** No port forwarding to the Duet, no open MCP server.
9. Do not share **logs** unchecked: the audit log and reports can contain IP addresses and file names.
10. **After a restart of the Duet** (power loss, reset) heaters are off and axes are not homed. If you want to continue a print with `resurrect.g`, the printed part must not have changed in the meantime, only the head position may. (This is not automated yet.)

## Reporting security problems

Please do **not** report security problems in a public issue. Use the private reporting function of the repository ("Security", then "Report a vulnerability"). See [SECURITY.md](SECURITY.md).

---

# Sicherheit (Deutsch)

## Haftungsausschluss

Die Software ist eine frühe Testversion (Alpha), wird ohne jede Gewährleistung bereitgestellt und die Nutzung erfolgt auf eigenes Risiko. Es ist ein inoffizielles Community-Projekt und steht in keiner Verbindung zu Duet3D. Heizungen können Brände auslösen, Motoren können verletzen und die Maschine beschädigen. **Lass eine Maschine nie unbeaufsichtigt laufen.**

## Was der Server schützt (zweite Ebene)

Die erste Ebene bleibt die Firmware (RepRapFirmware): Temperaturgrenzen (`M143`), Überwachung der Heizungen, Achsgrenzen (`M208`), Endstopps. Der Server prüft zusätzlich und früher. Die vollständige Liste steht in [SAFETY_RULES.de.md](SAFETY_RULES.de.md). Kurz:

- **Nur-Lesen als Standard.** Steuerwerkzeuge sind aus, bis du `DUET_READ_ONLY=false` setzt.
- **Zustimmung des Menschen** für Druckstart, Referenzieren, Heizen und andere riskante Befehle. Die Frage stellt der Server selbst (MCP-Elicitation oder Systemdialog), die KI kann nicht für dich zustimmen.
- **Harte Sperren** für Konfigurations-, Firmware-, Netzwerk- und Grenzänderungen, auch mit Zustimmung.
- **Grenzen vor dem Senden:** Temperaturen, Bauraum, nicht referenzierte Achsen, Makro-Allowlist.
- **G-Code-Vorprüfung** (`preflight_gcode`) vor dem Upload.
- **Überwachung im Server** (nicht im Chat): Übertemperatur, Temperaturabweichung, Aufheiz-Zeitlimit, Stillstand, Neustart der Duet, Verbindungsverlust. Pause oder Heizungen aus, aber nur mit `DUET_READ_ONLY=false`.
- **Notaus** (`emergency_stop`, `M112`) ist immer verfügbar und wird nie hinterfragt.

## Was der Server nicht erkennen kann

- **Klemmendes oder gerissenes Filament**, verstopfte Düse, sich lösendes Druckteil. Die Duet misst den Vorschub nicht. Dafür hilft nur ein Filamentsensor oder dein Blick auf die Kamera.
- **Feuer oder Rauch.** Eine Kamera ist kein Sicherheitsgerät.
- **Ausfall von Server, PC oder Netzwerk.** Läuft der MCP-Server nicht, druckt die Duet allein weiter, ohne Überwachung durch ihn. Auch ohne diese Software muss die Maschine so gebaut sein, dass das gefahrlos ist.
- **Defekte Hardware**, die die Firmware nicht bemerkt (z. B. falsch montierter Thermistor, der Heizblock wird nicht heiß genug gemessen). Der Server pollt nur alle 10 Sekunden.
- **Eine falsche oder manipulierte KI.** Die Prüfungen sind Regeln im Code, kein Urteilsvermögen. Ein Modell kann eine Anfrage missverstehen; deshalb brauchen riskante Schritte deine Zustimmung und du musst jede Frage lesen.
- **Fehler in dieser Software.** Sie ist alpha. Sie wurde bisher nur auf einer Duet 2 WiFi mit RepRapFirmware 3.2 und einem kartesischen Drucker getestet.

## Voraussetzungen an deine Hardware

Bevor du den Server mit Steuerung benutzt, prüfe selbst:

- Die **Firmware-Schutzfunktionen** sind aktiv und getestet: Maximaltemperatur je Heizung (`M143`), Heizungs-Fehlerüberwachung, Thermistor-Anschluss. Teste das Abziehen eines Thermistors **ohne** diese Software.
- **Netzteil und Verkabelung** sind ausreichend dimensioniert, Heizungsleitungen sitzen fest, es gibt eine passende **Sicherung**.
- Ein **Rauchmelder** in der Nähe der Maschine, ein **Feuerlöscher** in Reichweite, brennbares Material fern.
- Ein **Notaus** oder ein Netzschalter, den du ohne Nachdenken erreichst. Optional eine schaltbare Steckdose.
- Die **Kamera** (falls genutzt) hat genug Licht. Im Dunkeln siehst du nichts.

## Betriebsregeln

1. Fange **nur lesend** an (`DUET_READ_ONLY=true`) und prüfe Status, Profil und Endstopps.
2. Teste Bewegungen **ohne Heizung und ohne Material**, mit der Hand am Notaus.
3. Der **erste Druck mit der Steuerung** läuft ohne Pause neben dir. Danach weißt du, wie sich das System verhält.
4. Prüfe das **Bett vor jedem Start** (leer, sauber, richtig eingestellt).
5. **Beantworte die Rückfragen bewusst.** Wenn dir die Frage nicht klar ist, lehne ab.
6. Lass **keine Heizung unbeaufsichtigt** an. Der Leerlauf-Wächter (`DUET_HEAT_IDLE_MINUTES`) ist ein Netz, kein Ersatz.
7. Das **DWC-Passwort** gehört in `.env` (nie ins Repository, nie in den Chat). Setze eines auf der Duet.
8. Nur im **lokalen Netz**. Kein Portforwarding zur Duet, kein offener MCP-Server.
9. Teile **keine Logs** ungeprüft: Audit-Log und Berichte können IP-Adressen und Dateinamen enthalten.
10. **Nach einem Neustart der Duet** (Stromausfall, Reset) sind die Heizungen aus und die Achsen nicht referenziert. Wer einen Druck mit `resurrect.g` fortsetzen will: Das Druckteil darf sich inzwischen nicht verändert haben, nur die Kopfposition darf es. (Das ist noch nicht automatisiert.)

## Sicherheitslücken melden

Bitte melde Sicherheitsprobleme **nicht** öffentlich in einem Issue, sondern über die private Meldefunktion des Repositorys ("Security" → "Report a vulnerability"). Siehe [SECURITY.md](SECURITY.md).
