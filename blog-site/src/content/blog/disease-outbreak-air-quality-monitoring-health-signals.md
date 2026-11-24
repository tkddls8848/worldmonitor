---
description: "Follow official disease outbreak reports and travel health notices in WorldMonitor."
title: "Monitor Disease Outbreaks on a Global Map"
metaTitle: "Disease Outbreak Monitoring | WorldMonitor"
keywords: "disease outbreak map, epidemic monitoring dashboard, WHO outbreak tracker, global health surveillance, health signals API"
audience: "Public-health analysts, NGO and travel-security teams, researchers, journalists, expats and frequent travelers"
heroImage: "/blog/images/blog/disease-outbreak-air-quality-monitoring-health-signals.jpg"
pubDate: "2026-07-21"
modifiedDate: "2026-07-22"
---

WorldMonitor puts official disease outbreak reports and travel health notices on the same map as conflict, displacement, and infrastructure. An outbreak can reshape travel and trade, so seeing its geographic context helps analysts follow the wider effects.

## Outbreak tracking from official and specialist sources

The disease-outbreak pipeline merges complementary sources rather than betting on one:

- **WHO Disease Outbreak News** — the official record of internationally significant events, read from WHO's own API.
- **CDC travel health notices** — the practical layer: what a major public-health agency thinks travelers need to know, by destination.
- **Outbreak News Today** — specialist reporting that often moves days ahead of official confirmation.
- A dedicated **outbreak tracker dataset** for structured, ongoing events.

Outbreaks appear in the **[Disease Outbreaks](https://www.worldmonitor.app/docs/panels/disease-outbreaks) panel** and as a map layer, so an event sits in geographic context: next to the airports it may close, the displacement it may cause, and the [country risk](/blog/posts/country-risk-monitoring-due-diligence-worldmonitor/) it feeds into.

## One health layer, one query

For agents and developers, the `get_health_signals` MCP tool returns current outbreak signals in a structured response, with the REST equivalents under the versioned health API. The [humanitarian workflow](/blog/posts/humanitarian-situational-awareness-ngo-security-monitoring-worldmonitor/) shows the field-security use; pairing it with [displacement data](/blog/posts/track-refugee-displacement-flows-unhcr-worldmonitor/) gives the fuller picture of pressure on a population.

A useful habit from the [15-minute briefing routine](/blog/posts/daily-intelligence-briefing-workflow-15-minutes/): scan health signals for the countries already on your watchlist. Outbreaks rarely stay health stories — they become border stories, supply stories, and political stories, and the analysts who tracked them from the WHO bulletin onward are never surprised by that.

## Limits

Outbreak reporting inherits the biases of surveillance: countries with strong health systems report more, so more reports don't always mean more disease. Official WHO confirmation lags the specialist press by design — that's what verification costs. A reporting gap does not establish that a disease is absent.

## Primary data sources

[WHO Disease Outbreak News](https://www.who.int/emergencies/disease-outbreak-news) and [CDC Travel Health Notices](https://wwwnc.cdc.gov/travel/notices) publish the official reports and notices.

## Frequently Asked Questions

**Which outbreak sources does WorldMonitor track?**

WHO Disease Outbreak News via WHO's API, CDC travel health notices, Outbreak News Today's specialist reporting, and a structured outbreak-tracker dataset — merged and deduplicated.

**Is this a replacement for official public-health guidance?**

No. It's situational awareness — early, aggregated, and geographically contextualized. Decisions about vaccination, treatment, or travel restrictions belong with official guidance.
