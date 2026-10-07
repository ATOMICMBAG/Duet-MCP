# Sicherheit / Safety

**Bitte zuerst lesen. / Please read first.**

## In short (English)

duet-mcp lets an AI assistant operate a machine with **heaters and motors**. Heaters can start fires, motors can crush fingers and break the machine.

- This is **alpha software, provided as is, without any warranty**. You use it at your own risk. It is an unofficial community project and **not affiliated with Duet3D**.
- **Never leave a machine running unattended**, with or without this software. Keep the emergency stop and the power switch within reach.
- The server adds a safety layer (limits, human confirmation, supervision), but it **cannot replace** the protections of the firmware and the hardware, and it cannot see everything (see "What it cannot detect").
- It starts **read-only**. Control tools only exist with `DUET_READ_ONLY=false`.
- Use it only in a **trusted local network**. The Duet speaks plain HTTP without encryption. Never expose the Duet or this server to the internet; use a VPN if you need remote access.

## Haftungsausschluss

Die Software ist eine frühe Testversion (Alpha), wird ohne jede Gewährleistung bereitgestellt und die Nutzung erfolgt auf eigenes Risiko. Es ist ein inoffizielles Community-Projekt und steht in keiner Verbindung zu Duet3D. Heizungen können Brände auslösen, Motoren können verletzen und die Maschine beschädigen. **Lass eine Maschine nie unbeaufsichtigt laufen.**

## Was der Server schützt (zweite Ebene)

Die erste Ebene bleibt die Firmware (RepRapFirmware): Temperaturgrenzen (`M143`), Überwachung der Heizungen, Achsgrenzen (`M208`), Endstopps. Der Server prüft zusätzlich und früher. Die vollständige Liste steht in [SAFETY_RULES.md](SAFETY_RULES.md). Kurz:

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

## Sicherheitslücken melden

Bitte melde Sicherheitsprobleme **nicht** öffentlich in einem Issue, sondern über die private Meldefunktion des Repositorys ("Security" → "Report a vulnerability"), sobald das Repository öffentlich ist. Bis dahin wende dich direkt an den Maintainer.
