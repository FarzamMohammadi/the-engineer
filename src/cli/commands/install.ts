import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getOutput } from "../output.js";

/** Generates OS-specific service configuration. Returns exit code. */
export function runInstall(engineerHome: string): number {
  const platform = process.platform;

  if (platform === "darwin") {
    return installLaunchd(engineerHome);
  }

  if (platform === "linux") {
    return installSystemd(engineerHome);
  }

  const out = getOutput();
  out.error(`Unsupported platform: ${platform}`);
  out.log("  Service installation is only supported on macOS and Linux.");
  return 1;
}

function installLaunchd(engineerHome: string): number {
  const out = getOutput();
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, "com.the-engineer.daemon.plist");
  const engineerBin = process.argv[1] ?? "engineer";

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.the-engineer.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${engineerBin}</string>
    <string>start</string>
    <string>--home</string>
    <string>${engineerHome}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(engineerHome, "logs", "launchd-stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(engineerHome, "logs", "launchd-stderr.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ENGINEER_HOME</key>
    <string>${engineerHome}</string>
  </dict>
</dict>
</plist>`;

  mkdirSync(plistDir, { recursive: true });
  writeFileSync(plistPath, plist, "utf8");

  out.success(`Generated: ${plistPath}`);
  out.blank();
  out.log("  To register the service:");
  out.log(`    launchctl load ${plistPath}`);
  out.blank();
  out.log("  To unregister:");
  out.log(`    launchctl unload ${plistPath}`);
  out.blank();
  out.log("  To check status:");
  out.log("    launchctl list | grep the-engineer");

  return 0;
}

function installSystemd(engineerHome: string): number {
  const out = getOutput();
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDir, "engineer.service");
  const engineerBin = process.argv[1] ?? "engineer";

  const unit = `[Unit]
Description=The Engineer - Autonomous Software Engineering Agent
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${engineerBin} start --home ${engineerHome}
Restart=on-failure
RestartSec=10
Environment=ENGINEER_HOME=${engineerHome}

[Install]
WantedBy=default.target
`;

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit, "utf8");

  out.success(`Generated: ${unitPath}`);
  out.blank();
  out.log("  To register and start the service:");
  out.log("    systemctl --user daemon-reload");
  out.log("    systemctl --user enable engineer");
  out.log("    systemctl --user start engineer");
  out.blank();
  out.log("  To check status:");
  out.log("    systemctl --user status engineer");
  out.blank();
  out.log("  To stop:");
  out.log("    systemctl --user stop engineer");

  return 0;
}
