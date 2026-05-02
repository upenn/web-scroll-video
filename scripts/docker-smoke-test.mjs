#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "docker-output");
const sourceArg = process.argv.includes("--source")
  ? process.argv[process.argv.indexOf("--source") + 1]
  : "local";

if (!["local", "github"].includes(sourceArg)) {
  console.error("Usage: node scripts/docker-smoke-test.mjs [--source local|github]");
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    console.error(`${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

mkdirSync(outputDir, { recursive: true });

console.log("Checking local CLI syntax...");
run(process.execPath, ["--check", "src/scroll-video.mjs"]);

const smokeUrl =
  "data:text/html,<style>body{margin:0;height:1800px;font:36px sans-serif;background:linear-gradient(%23fff,%23cdf)}main{padding:32px}</style><main><h1>Web Scroll Smoke Test</h1><p>Clean Linux container render.</p></main>";

const dockerScript = `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq --no-install-recommends chromium ffmpeg git ca-certificates fonts-liberation

cat > /usr/local/bin/chromium-no-sandbox <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/chromium --no-sandbox "$@"
EOF
chmod +x /usr/local/bin/chromium-no-sandbox

if [ "$WEB_SCROLL_TEST_SOURCE" = "github" ]; then
  git clone https://github.com/upenn/web-scroll-video.git /tmp/web-scroll-video
  cd /tmp/web-scroll-video
else
  cd /work
fi

node --check src/scroll-video.mjs
chromium --version
ffmpeg -version | head -n 1

node src/scroll-video.mjs "${smokeUrl}" \\
  --out /out/smoke.mp4 \\
  --width 640 \\
  --height 360 \\
  --fps 10 \\
  --duration 2 \\
  --delay 100 \\
  --chrome-path /usr/local/bin/chromium-no-sandbox

ffprobe -v error -select_streams v:0 \\
  -show_entries stream=width,height,r_frame_rate,duration,codec_name \\
  -of default=noprint_wrappers=1 \\
  /out/smoke.mp4
`;

console.log(`Running Docker smoke test from ${sourceArg} source...`);

const dockerArgs = [
  "run",
  "--rm",
  "--shm-size=1g",
  "-e",
  `WEB_SCROLL_TEST_SOURCE=${sourceArg}`,
  "--mount",
  `type=bind,source=${outputDir},target=/out`,
];

if (sourceArg === "local") {
  dockerArgs.push("--mount", `type=bind,source=${repoRoot},target=/work,readonly`);
}

dockerArgs.push("node:22-bookworm", "bash", "-lc", dockerScript);

run("docker", dockerArgs);

console.log(`Docker smoke video wrote to ${path.join(outputDir, "smoke.mp4")}`);
