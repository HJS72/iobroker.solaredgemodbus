# ioBroker SolarEdge Modbus Adapter (Custom)

Dieser Adapter liest SolarEdge Modbus Register, rechnet Scale Factors um und legt die gewuenschten Datenpunkte in ioBroker an.

## Ziel-Datenpunkte

- Batterie_Energie_max
- Batterie_Leistung
- Batterie_SOC
- Batterie_SOC_min
- Batterie_Time
- Batterie_Uhrzeit
- PV_Leistung
- PV_Energie_Gesamt
- PV_Energie_Tag
- Solaredge_Leistung
- Solaredge_Energie_Tag
- Grid_Leistung
- Batterie_Betriebszustand (schreibbar)

## Verwendete Register (Default)

Die Defaults orientieren sich an SunSpec/SolarEdge Register-Layouts, wie sie in Open-Source-Implementierungen genutzt werden (u. a. `solaredge-modbus-multi`).

Hinweis: Register sind in der Admin-Seite komplett konfigurierbar.

| Zweck | Typ | Default Register |
|---|---|---:|
| Inverter AC Power | int16 | 40083 |
| Inverter AC Power SF | int16 | 40084 |
| Inverter AC Energy Total | uint32 | 40094 |
| Inverter AC Energy SF | int16 | 40096 |
| Meter AC Power (Grid) | int16 | 40207 |
| Meter AC Power SF | int16 | 40211 |
| Battery DC Power | float32 (little-word) | 57716 |
| Battery Energy Max | float32 (little-word) | 57726 |
| Battery SOC | float32 (little-word) | 57732 |
| Battery Export Energy | uint64 | 57718 |
| Battery Import Energy | uint64 | 57722 |
| Battery SOC Min (optional) | float32 (little-word) | 0 (deaktiviert) |

## Formeln

### SunSpec Scale Factor

Wenn ein Wert + SF existiert:

value = raw * 10^sf

### Konfigurierbare Formeln pro Datenpunkt

In der Admin-Seite gibt es einen eigenen Tab `Formulas`.
Jeder Ziel-Datenpunkt kann dort per Ausdruck ueberschrieben werden.

Verfuegbare Variablen (Auszug):

- inverterAcPower
- inverterEnergyWh
- gridPower
- batteryDcPower
- batteryEnergyMax
- batteryEnergyAvailable (berechnet aus batteryEnergyMax * max(0, batterySoc - batterySocMin) / 100)
- batterySoc
- batteryImportEnergyWh
- batteryExportEnergyWh
- batteryAcEfficiency

Bei ungueltiger Formel faellt der Adapter automatisch auf die Standardformel zurueck.

### Leistungswerte

- Solaredge_Leistung = Inverter_AC_Power (AC)
- Grid_Leistung = Meter_AC_Power (AC, optional invertierbar)
- Batterie_Leistung = Battery_DC_Power * batteryAcEfficiency (default 0.96), als AC-Schaetzung
- PV_Leistung = Solaredge_Leistung - Batterie_Leistung

### Energiewerte

- PV_Energie_Gesamt = Inverter_AC_Energy_Total (AC)
- Solaredge_Energie_Tag = lokal integrierte Tagesenergie aus Solaredge_Leistung
- PV_Energie_Tag = lokal integrierte Tagesenergie aus PV_Leistung
- Batterie_Energie_max = Battery_Energy_Max

### Batteriestatus

- Batterie_SOC = Battery_SOC
- Batterie_SOC_min = optional eigenes Register, sonst Tages-Minimum aus Batterie_SOC
- Batterie_Time:
  - bei Entladung (>0 W): Battery_Energy_Available / Batterie_Leistung
  - bei Ladung (<0 W): (Battery_Energy_Max - Battery_Energy_Available) / |Batterie_Leistung|
- Batterie_Uhrzeit:
  - bei Ladung (<0 W): Uhrzeit, wann 100% SOC erreicht wird
  - bei Entladung (>0 W): Uhrzeit, wann SOC_min erreicht wird

## Wichtige Hinweise

- Alle geforderten Leistungs-Datenpunkte werden als AC abgelegt.
- Batterie-Leistung ist ohne explizites AC-Batterieregister eine Naeherung aus DC-Leistung * Wirkungsgrad.
- Je nach Firmware/Geraet koennen Adress-Offsets variieren. Deshalb sind alle Register in Admin einstellbar.
- Register werden als absolute 40001-basierte Modbus-Adressen behandelt (Standard in vielen Dokus).
- Legacy-Eintraege mit zero-based Adressen werden automatisch nach absolut konvertiert (z. B. `15` -> `40016`) und einmalig als Warnung geloggt.
- Register werden gebuendelt (Batch-Reads) gelesen, um deutlich weniger Modbus-Requests zu erzeugen.

## Battery Operating State (Register 103237)

- Der Datenpunkt `Batterie_Betriebszustand` ist les- und schreibbar.
- Register-Adresse: `registers.batteryOperatingState` (Default `103237`).
- Kodierung: `unsigned32`, `big-endian`, `word-swap`.
- Zulaessige Werte:
  - `0` Off
  - `1` Standby
  - `2` Init
  - `3` Charge
  - `4` Discharge
  - `5` Fault
  - `7` Idle
- Bei `ack=false` schreibt der Adapter den Zustand auf den Wechselrichter.

## Testwrapper (lokal + SolarEdge Cloud Vergleich)

Es gibt einen Wrapper fuer Vergleichslauf lokal gegen Cloud:

1. Beispiel kopieren:

```bash
cp tools/testwrapper.config.example.json tools/testwrapper.config.json
```

2. `tools/testwrapper.config.json` mit Site-ID und API-Key fuellen.

3. Starten:

```bash
npm run test:wrapper
```

Output:

- Konsolen-Tabelle mit lokalen Werten, Cloud-Werten und Delta
- Snapshot-Datei: `tools/output/compare-latest.json`
- Historie als JSON: `tools/output/compare-history.json`
- Historie als NDJSON: `tools/output/compare-history.ndjson`

## Dashboard

Lokales Dashboard fuer Verlauf und Delta-Werte:

1. Wrapper laufen lassen (damit Daten in `tools/output` geschrieben werden)
2. Dashboard starten:

```bash
npm run dashboard
```

3. Browser oeffnen:

http://localhost:8099

Hinweis zum "Adapter starten":

- Der Wrapper kann optional parallel einen Prozess starten (`adapter.enabled` + `adapter.command`).
- Ein echter ioBroker-Adapterlauf braucht dennoch eine laufende ioBroker-Umgebung/js-controller.

## Start

```bash
npm install
npm run check
```
