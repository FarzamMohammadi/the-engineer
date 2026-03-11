import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Generates OS-specific service configuration. Returns exit code. */
export function runInstall(engineerHome: string): number {
  const platform = process.platform;

  if (platform === "darwin") {
    return installLaunchd(engineerHome);
  }

  if (platform === "linux") {
    return installSystemd(engineerHome);
  }

  console.log(`  Unsupported platform: ${platform}`);
  console.log("  Service installation is only supported on macOS and Linux.");
  return 1;
}

function installLaunchd(engineerHome: string): number {
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

  console.log(`  Generated: ${plistPath}`);
  console.log("");
  console.log("  To register the service:");
  console.log(`    launchctl load ${plistPath}`);
  console.log("");
  console.log("  To unregister:");
  console.log(`    launchctl unload ${plistPath}`);
  console.log("");
  console.log("  To check status:");
  console.log("    launchctl list | grep the-engineer");

  return 0;
}

function installSystemd(engineerHome: string): number {
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

  console.log(`  Generated: ${unitPath}`);
  console.log("");
  console.log("  To register and start the service:");
  console.log("    systemctl --user daemon-reload");
  console.log("    systemctl --user enable engineer");
  console.log("    systemctl --user start engineer");
  console.log("");
  console.log("  To check status:");
  console.log("    systemctl --user status engineer");
  console.log("");
  console.log("  To stop:");
  console.log("    systemctl --user stop engineer");

  return 0;
}
