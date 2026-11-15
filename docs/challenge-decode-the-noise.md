# Main challenge: Decode the Noise (Hostinger)

**ID 357 · Agentic AI Track · by Hostinger**

### In one sentence
Build an AI tool that **detects propaganda, botnets, and malicious actors online**, and **deploy it live on Hostinger infrastructure**.

### Why Hostinger cares
The internet was meant to connect people, yet it became "the most powerful manipulation machine": propaganda spreads faster than facts, botnets shape public opinion, and malicious actors are growing ever more sophisticated. Hostinger hosts **millions of websites** and sees this noise up close. Their thesis: the same technology that powers the web can also protect it. The best detection ideas will come from teams that go from idea to live tool in 48 hours.

### What you need to build
A tool that analyzes **text, social media content, or web traffic patterns** and finds signs of:
- coordinated propaganda,
- bot amplification,
- malicious actor behavior.

**Open format:** API, dashboard, classifier with an explainable verdict, monitoring service for site owners.

### Hard requirement
**Must run live on Hostinger infrastructure** by the end of the hackathon, with a **public URL** that judges can open.
They care more about the **strength and honesty of the detection logic**, including **handling false positives**, than a pretty frontend.

### Four tracks (one or a combination)
| Track | What it is (in plain terms) | Signals to look for |
|---|---|---|
| **Spot the swarm** | Find the "swarm": botnets, astroturfing (fake "grassroots" support), brigading (organized raids) | Posting times, account similarity, text repetition, amplification patterns. **Not by a single post, but across a group** |
| **Name the technique** | Name the manipulation technique and **explain in plain words** why it is propaganda, rather than just "this is propaganda" | Loaded language, appeal to fear, whataboutism ("and what about you?" deflection), fake authority |
| **Clean the traffic** | Distinguish malicious bots, scrapers, and credential stuffing from human visitors in **web server logs** + a clear dashboard for the site owner | IP, rate, user-agent, paths, login patterns |
| **Trust the source** | Assess the **provenance** of a page or account so a person can tell who is actually behind it | Domain age, cloned content, AI-generated text, link networks |

**Especially valued:** transparent and **measurable** approaches. "Show precision and false positive rate, not just a demo that works on the happy path."

### What you get (free for 1 month for each team)
- **Hostinger VPS KVM 2:** 2 vCPU, 8 GB RAM, 100 GB NVMe, 8 TB bandwidth, root, Docker, **free domain**, one-click templates: Ollama, n8n, Node.js, Python.
- **Hostinger AI Router:** one API key and shared balance for **150+ models** (Anthropic, OpenAI, DeepSeek, Mistral, xAI…), compatible with the OpenAI and Anthropic SDKs.
- **Hostinger AI Builder** for 1 month: "vibe-code" a frontend, dashboard, or landing page and publish it.
- **Hostinger Connector, API, and CLI:** connect Claude Code, Cursor, VS Code, or any MCP client → deploy, manage the server and domain from your editor. Docs: docs.hostinger.com/hostinger-connector · API: developers.hostinger.com · MCP: github.com/hostinger/api-mcp-server.
- **Mentors:** Minijus Savickas (VPS Product), Emilis Strimaitis (Innovations, AI agents) at the booth all weekend + help channel.
- Any language, framework, or model (open-source or hosted), as long as **the final product runs on Hostinger**.
- **Talk:** "Vibe Coding Solved Building. Now Comes the Hard Part", **Sat 13:00** (about how to run, secure, and operate code). Promising teams get a follow-up conversation with Hostinger engineers after the event.

### How projects are judged
| Criterion | Weight | What it means in practice |
|---|---|---|
| **Detection quality** (accuracy, false positive handling, explainability) | **40%** | Metrics table on labeled data + explanation of each verdict |
| **Engineering and live deployment on Hostinger** | 25% | Public URL, runs reliably |
| **Originality and real-world impact** | 20% | Not "just another fake-news classifier" |
| **Demo clarity** | 15% | A judge understands what it does and why in 2 minutes |

### Prizes
€2000 / €1000 / €500. All three winning teams: **one year of hosting + domain**, merch, **spotlight on Hostinger social media**.

### Pitfalls
- Without a live URL on Hostinger, it is a no-go.
- You need **labeled data** for metrics (otherwise 40% is at risk).
- False positives mean accusing innocent people. You need an "uncertain" threshold and honesty.

---
