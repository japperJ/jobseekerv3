# Jobseeker v2

A local web chat assistant that turns a job listing into tailored CV and cover-letter PDFs in English and Danish.

## Knowledge folder

The `knowledge/` folder contains the candidate's private source information. It is intentionally excluded from Git by `.gitignore` and must be created/populated separately on each machine.

The app reads these Markdown files:

| File | What it should contain |
| --- | --- |
| `knowledge/profile.md` | Name, contact details, location, LinkedIn URL, headline, languages, and professional identity |
| `knowledge/experience.md` | Employment history, job titles, employers, dates, responsibilities, technologies, and project context |
| `knowledge/skills.md` | Technical skills, platforms, tools, methods, certifications, and confirmed skills from previous applications |
| `knowledge/achievements.md` | Measurable results, metrics, awards, major projects, and business impact |
| `knowledge/preferences.md` | Preferred roles, industries, locations, work arrangements, salary considerations, and application-writing preferences |

All five files are required for the best results. The app can start when one is missing, but it will have less information for matching jobs and generating documents. Use Markdown headings and bullet points; write truthful, specific details and include numbers wherever possible.

Example structure:

```text
# Profile
- Name: Your Name
- Location: Aarhus, Denmark
- LinkedIn: https://linkedin.com/in/your-profile

# Experience
## Company — Job title | 2020–Present
- Responsibility or achievement
- Result with a measurable outcome
```

The application may append confirmed skills to `knowledge/skills.md` after an interview. Back up this folder locally; it contains personal data and should not be committed to a public repository.

## Setup

Requirements: Node.js 22 or newer and GitHub Copilot CLI access.

```powershell
npm install
Copy-Item .env.example .env
# Create/populate the five files in knowledge\
npm run build
npm start
```

Open <http://localhost:4173>.

Useful environment variables are documented in `.env.example`, including `PORT`, `COPILOT_MODEL`, `COPILOT_CLI_PATH`, and `KNOWLEDGE_DIR`.

## Output

Generated files are written to `applications/`, which is also excluded from Git:

- English CV PDF
- Danish CV PDF
- English cover-letter PDF
- Danish application PDF
