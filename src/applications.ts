import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
import type { ApplicationFiles, ApplicationPreflightReport, ApplicationStatus, JobInfo } from "./types.js";

export interface ApplicationRecord extends ApplicationFiles {
  company: string;
  role: string;
  location: string | null;
  date: string;
  score: number;
  summary: string;
  status: ApplicationStatus;
  preflightFile: string | null;
}

const INDEX_FILE = "index.json";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function applicationFolderName(job: JobInfo): string {
  const company = slugify(job.company ?? "unknown-company");
  const role = slugify(job.role);
  return `${company}-${role}`;
}

/** Reads the applications index (or returns an empty list). */
export async function readIndex(): Promise<ApplicationRecord[]> {
  try {
    const raw = await fs.readFile(path.join(config.APPLICATIONS_DIR, INDEX_FILE), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Persists a completed application: job description + 4 PDFs in a dedicated
 * folder, plus an entry in index.json. The deterministic PDF preflight
 * report is persisted alongside the files and drives the draft/sendable
 * status recorded in the index — it must run before this is called.
 */
export async function saveApplication(
  job: JobInfo,
  jobDescriptionText: string,
  files: { cvEn: string; cvDa: string; coverEn: string; coverDa: string },
  score: number,
  preflight?: ApplicationPreflightReport,
): Promise<ApplicationFiles> {
  const folder = applicationFolderName(job);
  const dir = path.join(config.APPLICATIONS_DIR, folder);
  await fs.mkdir(dir, { recursive: true });

  const names = {
    cvEn: "CV_English.pdf",
    cvDa: "CV_Dansk.pdf",
    coverEn: "Cover_Letter_English.pdf",
    coverDa: "Ansoegning_Dansk.pdf",
    jobDescription: "job-description.md",
    preflight: "preflight-report.json",
  };

  await fs.writeFile(path.join(dir, names.jobDescription), jobDescriptionText, "utf8");

  let preflightFile: string | null = null;
  if (preflight) {
    preflightFile = path.join(dir, names.preflight);
    await fs.writeFile(preflightFile, JSON.stringify(preflight, null, 2), "utf8");
  }

  const appFiles: ApplicationFiles = {
    folder,
    cvEn: path.join(dir, names.cvEn),
    cvDa: path.join(dir, names.cvDa),
    coverEn: path.join(dir, names.coverEn),
    coverDa: path.join(dir, names.coverDa),
    jobDescription: path.join(dir, names.jobDescription),
  };

  // Move generated PDFs into place.
  for (const key of ["cvEn", "cvDa", "coverEn", "coverDa"] as const) {
    if (files[key]) {
      await fs.rename(files[key], appFiles[key]).catch(async () => {
        // Rename may fail across devices; copy instead.
        await fs.copyFile(files[key], appFiles[key]);
        await fs.unlink(files[key]).catch(() => {});
      });
    }
  }

  const record: ApplicationRecord = {
    ...appFiles,
    company: job.company ?? "Unknown",
    role: job.role,
    location: job.location,
    date: new Date().toISOString(),
    score,
    summary: job.summary,
    status: preflight?.status ?? "draft",
    preflightFile,
  };

  const index = await readIndex();
  // Re-applying to the same job folder should update the existing entry,
  // not create a duplicate history record.
  const filtered = index.filter((r) => r.folder !== folder);
  filtered.unshift(record);
  await fs.writeFile(
    path.join(config.APPLICATIONS_DIR, INDEX_FILE),
    JSON.stringify(filtered, null, 2),
    "utf8",
  );

  return appFiles;
}

export async function deleteApplication(folder: string): Promise<boolean> {
  const index = await readIndex();
  const record = index.find((application) => application.folder === folder);
  if (!record) return false;

  const applicationDir = path.join(config.APPLICATIONS_DIR, folder);
  const relative = path.relative(config.APPLICATIONS_DIR, applicationDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid application folder");
  }

  await fs.rm(applicationDir, { recursive: true, force: true });
  await fs.writeFile(
    path.join(config.APPLICATIONS_DIR, INDEX_FILE),
    JSON.stringify(index.filter((application) => application.folder !== folder), null, 2),
    "utf8",
  );
  return true;
}
