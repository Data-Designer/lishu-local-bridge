import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const port = Number(process.env.LOCAL_BRIDGE_PORT || 4318);
const host = process.env.LOCAL_BRIDGE_HOST || "127.0.0.1";
const useHttps = String(process.env.LOCAL_BRIDGE_USE_HTTPS || "").trim() === "1";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultTlsDir = path.join(currentDir, "certs");
const tlsKeyPath = process.env.LOCAL_BRIDGE_TLS_KEY || path.join(defaultTlsDir, "localhost-key.pem");
const tlsCertPath = process.env.LOCAL_BRIDGE_TLS_CERT || path.join(defaultTlsDir, "localhost-cert.pem");
const jobs = new Map();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function slugifyValue(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripCodeFence(text = "") {
  return String(text || "").replace(/^```(?:json|markdown)?\s*/i, "").replace(/```$/, "").trim();
}

async function isCommandAvailable(command) {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function getExecutors() {
  const [claudeAvailable, codexAvailable] = await Promise.all([
    isCommandAvailable("claude"),
    isCommandAvailable("codex")
  ]);
  return {
    default: "user-llm",
    items: [
      { id: "claude-cli", label: "Claude CLI", available: claudeAvailable, description: "在你的本机调用 claude -p。" },
      { id: "codex-cli", label: "Codex CLI", available: codexAvailable, description: "在你的本机调用 codex exec。" }
    ]
  };
}

async function fetchRelatedWork(siteBaseUrl, payload) {
  const params = new URLSearchParams();
  const keyword = payload.topic || payload.domain || "";
  params.set("keyword", keyword);
  params.set("page", "1");
  params.set("pageSize", "50");
  if (payload.list) params.set("list", payload.list);
  const response = await fetch(`${siteBaseUrl.replace(/\/$/, "")}/api/articles?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch related work from ${siteBaseUrl}`);
  }
  return response.json();
}

async function runExecutor(executor, prompt, cwd) {
  if (executor === "claude-cli") {
    const { stdout } = await execFileAsync(
      "claude",
      ["-p", "--dangerously-skip-permissions", prompt],
      { cwd, timeout: 1000 * 60 * 12, maxBuffer: 1024 * 1024 * 12 }
    );
    return stdout;
  }

  if (executor === "codex-cli") {
    const { stdout } = await execFileAsync(
      "codex",
      ["exec", "--skip-git-repo-check", "-C", cwd, "--dangerously-bypass-approvals-and-sandbox", prompt],
      { cwd, timeout: 1000 * 60 * 12, maxBuffer: 1024 * 1024 * 12 }
    );
    return stdout;
  }

  throw new Error(`Unsupported executor: ${executor}`);
}

function updateJob(jobId, patch) {
  const current = jobs.get(jobId);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  return next;
}

async function writeRunFiles(runDir, input, result) {
  await mkdir(runDir, { recursive: true });
  const summaryMarkdown = [
    `# ${result.paperTitle || "AutoResearch Run"}`,
    "",
    `- Executor: ${result.source.executionMode}`,
    `- Target Journal: ${result.targetJournal || "N/A"}`,
    "",
    "## Abstract",
    result.abstract || "",
    "",
    "## Contribution",
    result.contribution || "",
    "",
    "## Experiment Plan",
    result.experimentPlan || "",
    "",
    "## Final Manuscript",
    result.finalManuscript || ""
  ].join("\n");

  await Promise.all([
    writeFile(path.join(runDir, "input.json"), JSON.stringify(input, null, 2), "utf8"),
    writeFile(path.join(runDir, "result.json"), JSON.stringify(result, null, 2), "utf8"),
    writeFile(path.join(runDir, "summary.md"), summaryMarkdown, "utf8"),
    writeFile(path.join(runDir, "final-manuscript.md"), result.finalManuscript || "", "utf8")
  ]);
}

async function testRunDirectory(runDirectory) {
  const normalized = String(runDirectory || "").trim();
  if (!normalized) {
    throw new Error("Please provide a local run directory");
  }
  if (!path.isAbsolute(normalized)) {
    throw new Error("Local run directory must be an absolute path");
  }
  if (!existsSync(path.dirname(normalized))) {
    throw new Error("The parent directory of the run directory does not exist");
  }
  await mkdir(normalized, { recursive: true });
  const probe = path.join(normalized, `.lishu-bridge-test-${Date.now()}.tmp`);
  await writeFile(probe, "ok", "utf8");
  await unlink(probe);
  return normalized;
}

async function pickRunDirectory() {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Select AutoResearch run directory")'
    ]);
    return String(stdout || "").trim();
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      '$dialog.Description = "Select AutoResearch run directory"',
      "if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }"
    ].join("; ");
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
    return String(stdout || "").trim();
  }

  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=Select AutoResearch run directory"]);
      return String(stdout || "").trim();
    } catch {
      const { stdout } = await execFileAsync("kdialog", ["--getexistingdirectory"]);
      return String(stdout || "").trim();
    }
  }

  throw new Error("Current platform does not support native directory picking");
}

async function executeAutoResearchJob(jobId, body) {
  const siteBaseUrl = String(body.siteBaseUrl || "").trim();
  const executor = String(body.executor || "").trim();
  const outputLanguage = String(body.outputLanguage || "zh-CN").trim() === "en-US" ? "en-US" : "zh-CN";
  const runBaseDir = String(body.runDirectory || "").trim();
  const targetJournal = String(body.targetJournal || "").trim() || "Academy of Management Journal";
  const iterations = Math.min(3, Math.max(1, Number(body.iterations || 2)));
  const seedKeyword = String(body.topic || body.domain || "").trim();

  if (!siteBaseUrl) throw new Error("siteBaseUrl is required for local bridge execution");
  if (!seedKeyword) throw new Error("Please provide a domain or topic");
  if (!runBaseDir) throw new Error("Please provide a local run directory");
  if (!path.isAbsolute(runBaseDir)) throw new Error("Local run directory must be an absolute path");
  if (!existsSync(path.dirname(runBaseDir))) throw new Error("The parent directory of the run directory does not exist");

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = path.join(runBaseDir, slugifyValue(`${seedKeyword}-${runId}`) || runId);
  await mkdir(runDir, { recursive: true });

  updateJob(jobId, { status: "running", progress: 10, stage: "获取 related work", detail: "正在从网站 API 获取真实论文样本。" });
  const related = await fetchRelatedWork(siteBaseUrl, body);
  const items = (related.items || []).slice(0, 30).map((item) => ({
    title: item.title,
    abstract: item.abstract,
    journalName: item.journalName,
    publishedAt: item.publishedAt,
    keywords: item.keywords,
    citedBy: item.citedBy,
    url: item.url
  }));

  updateJob(jobId, { progress: 36, stage: "本机 agent 起草中", detail: `正在通过 ${executor} 在你的电脑上完成 AutoResearch。` });
  const prompt = [
    "You are running a local AutoResearch workflow for a business research portal.",
    "Return strict JSON only with this shape:",
    '{"selected_idea":{"title":"...","rationale":"...","search_keyword":"..."},"candidate_ideas":[{"title":"...","rationale":"...","search_keyword":"..."}],"paper_title":"...","abstract":"...","contribution_markdown":"...","experiment_plan_markdown":"...","rounds":[{"round":1,"decision_status":"Major Revision","editor_summary_markdown":"...","revision_idea":"...","change_summary_markdown":"..."}],"final_manuscript_markdown":"..."}',
    `Write in ${outputLanguage === "en-US" ? "polished academic English" : "polished professional Chinese"}.`,
    "Do not fabricate executed experiments, sample sizes, coefficients, significance levels, or completed empirical findings.",
    "Produce a promising research package: selected idea, related-work-aware positioning, research design, up to requested review iterations, and a final manuscript draft.",
    `Target journal: ${targetJournal}`,
    `Requested review iterations: ${iterations}`,
    `User domain: ${body.domain || "N/A"}`,
    `User topic: ${body.topic || "N/A"}`,
    `Related work sample: ${JSON.stringify(items)}`
  ].join("\n");
  const text = await runExecutor(executor, prompt, runDir);
  const parsed = JSON.parse(stripCodeFence(text));

  updateJob(jobId, { progress: 84, stage: "写入本地产物", detail: "正在把最终论文草案与中间结果写入你的 run 目录。" });
  const result = {
    selectedIdea: {
      title: String(parsed.selected_idea?.title || body.topic || body.domain || seedKeyword).trim(),
      rationale: String(parsed.selected_idea?.rationale || "").trim(),
      searchKeyword: String(parsed.selected_idea?.search_keyword || seedKeyword).trim()
    },
    candidateIdeas: Array.isArray(parsed.candidate_ideas) ? parsed.candidate_ideas.slice(0, 3) : [],
    paperTitle: String(parsed.paper_title || body.topic || body.domain || "AutoResearch Draft").trim(),
    abstract: String(parsed.abstract || "").trim(),
    contribution: String(parsed.contribution_markdown || "").trim(),
    experimentPlan: String(parsed.experiment_plan_markdown || "").trim(),
    relatedArticles: items.slice(0, 12),
    rounds: Array.isArray(parsed.rounds)
      ? parsed.rounds.slice(0, iterations).map((round, index) => ({
          round: Number(round.round || index + 1),
          decisionStatus: String(round.decision_status || "Major Revision").trim(),
          editorSummary: String(round.editor_summary_markdown || "").trim(),
          revisionIdea: String(round.revision_idea || "").trim(),
          changeSummary: String(round.change_summary_markdown || "").trim()
        }))
      : [],
    finalManuscript: String(parsed.final_manuscript_markdown || "").trim(),
    targetJournal,
    outputLanguage,
    run: {
      runId,
      runDirectory: runDir,
      files: [
        path.join(runDir, "input.json"),
        path.join(runDir, "result.json"),
        path.join(runDir, "summary.md"),
        path.join(runDir, "final-manuscript.md")
      ]
    },
    source: {
      label: "Local Bridge + Local CLI + Real Related Work",
      executionMode: executor,
      siteBaseUrl,
      executedExperiments: false,
      searchedAt: new Date().toISOString()
    }
  };

  await writeRunFiles(runDir, body, result);
  updateJob(jobId, {
    status: "completed",
    progress: 100,
    stage: "已完成",
    detail: "本地桥接器已完成 AutoResearch。",
    result
  });
}

async function buildTlsOptions() {
  if (!useHttps) return null;
  if (!existsSync(tlsKeyPath) || !existsSync(tlsCertPath)) {
    throw new Error(
      `HTTPS mode requires certificate files. Expected key at ${tlsKeyPath} and cert at ${tlsCertPath}. Run "npm run local-bridge:cert" first.`
    );
  }
  const [key, cert] = await Promise.all([readFile(tlsKeyPath), readFile(tlsCertPath)]);
  return { key, cert };
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        host,
        port,
        protocol: useHttps ? "https" : "http",
        baseUrl: `${useHttps ? "https" : "http"}://${host}:${port}`,
        ...(await getExecutors())
      });
      return;
    }

    if (pathname === "/executors" && req.method === "GET") {
      sendJson(res, 200, await getExecutors());
      return;
    }

    if (pathname === "/jobs" && req.method === "POST") {
      const body = await parseBody(req);
      const executors = await getExecutors();
      const selected = executors.items.find((item) => item.id === body.executor);
      if (!selected || !selected.available) {
        sendJson(res, 400, { message: "Selected local executor is not available on this machine" });
        return;
      }
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();
      jobs.set(jobId, {
        id: jobId,
        status: "queued",
        progress: 0,
        stage: "等待执行",
        detail: "本地桥接器已接收任务。",
        createdAt: now,
        updatedAt: now,
        result: null,
        error: null
      });
      queueMicrotask(async () => {
        try {
          await executeAutoResearchJob(jobId, body);
        } catch (error) {
          updateJob(jobId, {
            status: "failed",
            progress: 100,
            stage: "执行失败",
            detail: error.message || "本地桥接器执行失败",
            error: error.message || "本地桥接器执行失败"
          });
        }
      });
      sendJson(res, 202, jobs.get(jobId));
      return;
    }

    if (pathname === "/test-run-directory" && req.method === "POST") {
      const body = await parseBody(req);
      const runDirectory = await testRunDirectory(body.runDirectory);
      sendJson(res, 200, {
        ok: true,
        runDirectory,
        message: `本地目录测试成功：${runDirectory}`
      });
      return;
    }

    if (pathname === "/pick-run-directory" && req.method === "GET") {
      const runDirectory = await pickRunDirectory();
      if (!runDirectory) {
        sendJson(res, 400, { message: "No directory selected" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        runDirectory,
        message: `已选择本地目录：${runDirectory}`
      });
      return;
    }

    if (pathname.startsWith("/jobs/") && req.method === "GET") {
      const jobId = decodeURIComponent(pathname.split("/").pop() || "");
      const job = jobs.get(jobId);
      if (!job) {
        sendJson(res, 404, { message: "Job not found" });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    sendJson(res, 404, { message: "Not found" });
  } catch (error) {
    sendJson(res, 500, { message: error.message || "Bridge error" });
  }
}

const tlsOptions = await buildTlsOptions();
const server = useHttps ? createHttpsServer(tlsOptions, handleRequest) : createHttpServer(handleRequest);

server.listen(port, host, () => {
  const protocol = useHttps ? "https" : "http";
  console.log(`理枢 Local Bridge running at ${protocol}://${host}:${port}`);
  if (useHttps) {
    console.log(`TLS key: ${tlsKeyPath}`);
    console.log(`TLS cert: ${tlsCertPath}`);
  }
});
