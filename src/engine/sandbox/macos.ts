import { dirname, resolve } from "node:path";
import {
  containsGlobChars,
  DANGEROUS_FILES,
  encodeSandboxedCommand,
  getDangerousDirectories,
  globToRegex,
  normalizePathForSandbox,
} from "./path-normalize.ts";

export interface ReadConfig {
  denyOnly: string[];
  allowWithinDeny?: string[];
}

export interface WriteConfig {
  allowOnly: string[];
  denyWithinAllow?: string[];
}

export interface SandboxProfileOptions {
  readConfig?: ReadConfig;
  writeConfig?: WriteConfig;
  needsNetworkRestriction: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  allowLocalBinding?: boolean;
  allowMachLookup?: string[];
  allowPty?: boolean;
  allowGitConfig?: boolean;
  enableWeakerNetworkIsolation?: boolean;
  logTag: string;
}

export interface SandboxWrapParams extends Omit<SandboxProfileOptions, "logTag"> {
  command: string;
  binShell: string;
}

const SESSION_SUFFIX = `_${Math.random().toString(36).slice(2, 11)}_SBX`;

export function generateLogTag(command: string): string {
  return `CMD64_${encodeSandboxedCommand(command)}_END_${SESSION_SUFFIX}`;
}

export function getSessionSuffix(): string {
  return SESSION_SUFFIX;
}

function escapePath(pathStr: string): string {
  return JSON.stringify(pathStr);
}

function getAncestorDirectories(pathStr: string): string[] {
  const ancestors: string[] = [];
  let current = dirname(pathStr);
  while (current !== "/" && current !== ".") {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

function toPosixPath(p: string): string {
  return p.replaceAll("\\", "/");
}

export function macGetMandatoryDenyPatterns(allowGitConfig = false): string[] {
  const cwd = process.cwd();
  const denyPaths: string[] = [];
  for (const fileName of DANGEROUS_FILES) {
    denyPaths.push(toPosixPath(resolve(cwd, fileName)));
    denyPaths.push(`**/${fileName}`);
  }
  for (const dirName of getDangerousDirectories()) {
    denyPaths.push(toPosixPath(resolve(cwd, dirName)));
    denyPaths.push(`**/${dirName}/**`);
  }
  denyPaths.push(toPosixPath(resolve(cwd, ".git/hooks")));
  denyPaths.push("**/.git/hooks/**");
  if (!allowGitConfig) {
    denyPaths.push(toPosixPath(resolve(cwd, ".git/config")));
    denyPaths.push("**/.git/config");
  }
  return [...new Set(denyPaths)];
}

function generateMoveBlockingRules(pathPatterns: string[], logTag: string): string[] {
  const rules: string[] = [];
  const ops = ["file-write-unlink", "file-write-create"];
  for (const pathPattern of pathPatterns) {
    const normalizedPath = toPosixPath(normalizePathForSandbox(pathPattern));
    if (containsGlobChars(normalizedPath)) {
      const regexPattern = globToRegex(normalizedPath);
      for (const op of ops) {
        rules.push(
          `(deny ${op}`,
          `  (regex ${escapePath(regexPattern)})`,
          `  (with message "${logTag}"))`,
        );
      }
      const staticPrefix = normalizedPath.split(/[*?[\]]/)[0] ?? "";
      if (staticPrefix.length > 0 && staticPrefix !== "/") {
        const baseDir = staticPrefix.endsWith("/")
          ? staticPrefix.slice(0, -1)
          : dirname(staticPrefix);
        for (const op of ops) {
          rules.push(
            `(deny ${op}`,
            `  (literal ${escapePath(baseDir)})`,
            `  (with message "${logTag}"))`,
          );
        }
        for (const ancestorDir of getAncestorDirectories(baseDir)) {
          for (const op of ops) {
            rules.push(
              `(deny ${op}`,
              `  (literal ${escapePath(ancestorDir)})`,
              `  (with message "${logTag}"))`,
            );
          }
        }
      }
    } else {
      for (const op of ops) {
        rules.push(
          `(deny ${op}`,
          `  (subpath ${escapePath(normalizedPath)})`,
          `  (with message "${logTag}"))`,
        );
      }
      for (const ancestorDir of getAncestorDirectories(normalizedPath)) {
        for (const op of ops) {
          rules.push(
            `(deny ${op}`,
            `  (literal ${escapePath(ancestorDir)})`,
            `  (with message "${logTag}"))`,
          );
        }
      }
    }
  }
  return rules;
}

function generateReadRules(
  config: ReadConfig | undefined,
  logTag: string,
  writeAllowPaths: string[] | undefined,
): string[] {
  if (!config) return ["(allow file-read*)"];
  const rules: string[] = [];
  let deniesRoot = false;
  rules.push("(allow file-read*)");
  for (const pathPattern of config.denyOnly) {
    const normalizedPath = toPosixPath(normalizePathForSandbox(pathPattern));
    if (normalizedPath === "/") deniesRoot = true;
    if (containsGlobChars(normalizedPath)) {
      const regexPattern = globToRegex(normalizedPath);
      rules.push(
        `(deny file-read*`,
        `  (regex ${escapePath(regexPattern)})`,
        `  (with message "${logTag}"))`,
      );
    } else {
      rules.push(
        `(deny file-read*`,
        `  (subpath ${escapePath(normalizedPath)})`,
        `  (with message "${logTag}"))`,
      );
    }
  }
  if (deniesRoot) {
    rules.push(`(allow file-read* (literal "/"))`);
  }
  for (const pathPattern of config.allowWithinDeny ?? []) {
    const normalizedPath = toPosixPath(normalizePathForSandbox(pathPattern));
    if (containsGlobChars(normalizedPath)) {
      const regexPattern = globToRegex(normalizedPath);
      rules.push(
        `(allow file-read*`,
        `  (regex ${escapePath(regexPattern)})`,
        `  (with message "${logTag}"))`,
      );
    } else {
      rules.push(
        `(allow file-read*`,
        `  (subpath ${escapePath(normalizedPath)})`,
        `  (with message "${logTag}"))`,
      );
    }
  }
  if (config.denyOnly.length > 0) {
    rules.push("(allow file-read-metadata", "  (vnode-type DIRECTORY))");
  }
  rules.push(...generateMoveBlockingRules(config.denyOnly, logTag));
  if (writeAllowPaths && writeAllowPaths.length > 0) {
    for (const pathPattern of writeAllowPaths) {
      const normalizedPath = toPosixPath(normalizePathForSandbox(pathPattern));
      for (const op of ["file-write-unlink", "file-write-create"]) {
        if (containsGlobChars(normalizedPath)) {
          const regexPattern = globToRegex(normalizedPath);
          rules.push(
            `(allow ${op}`,
            `  (regex ${escapePath(regexPattern)})`,
            `  (with message "${logTag}"))`,
          );
        } else {
          rules.push(
            `(allow ${op}`,
            `  (subpath ${escapePath(normalizedPath)})`,
            `  (with message "${logTag}"))`,
          );
        }
      }
    }
  }
  return rules;
}

function generateWriteRules(
  config: WriteConfig | undefined,
  logTag: string,
  allowGitConfig: boolean,
): string[] {
  if (!config) return ["(allow file-write*)"];
  const rules: string[] = [];
  for (const pathPattern of config.allowOnly) {
    const normalizedPath = toPosixPath(normalizePathForSandbox(pathPattern));
    if (containsGlobChars(normalizedPath)) {
      const regexPattern = globToRegex(normalizedPath);
      rules.push(
        `(allow file-write*`,
        `  (regex ${escapePath(regexPattern)})`,
        `  (with message "${logTag}"))`,
      );
    } else {
      rules.push(
        `(allow file-write*`,
        `  (subpath ${escapePath(normalizedPath)})`,
        `  (with message "${logTag}"))`,
      );
    }
  }
  const denyPaths = [
    ...(config.denyWithinAllow ?? []),
    ...macGetMandatoryDenyPatterns(allowGitConfig),
  ];
  for (const pathPattern of denyPaths) {
    const normalizedPath = toPosixPath(normalizePathForSandbox(pathPattern));
    if (containsGlobChars(normalizedPath)) {
      const regexPattern = globToRegex(normalizedPath);
      rules.push(
        `(deny file-write*`,
        `  (regex ${escapePath(regexPattern)})`,
        `  (with message "${logTag}"))`,
      );
    } else {
      rules.push(
        `(deny file-write*`,
        `  (subpath ${escapePath(normalizedPath)})`,
        `  (with message "${logTag}"))`,
      );
    }
  }
  rules.push(...generateMoveBlockingRules(denyPaths, logTag));
  return rules;
}

function networkRulesFor(opts: SandboxProfileOptions): string[] {
  const rules = ["; Network"];
  if (!opts.needsNetworkRestriction) {
    rules.push("(allow network*)");
    return rules;
  }
  if (opts.allowLocalBinding) {
    rules.push(
      '(allow network-bind (local ip "*:*"))',
      '(allow network-inbound (local ip "*:*"))',
      '(allow network-outbound (local ip "*:*"))',
    );
  }
  if (opts.allowAllUnixSockets) {
    rules.push(
      "(allow system-socket (socket-domain AF_UNIX))",
      '(allow network-bind (local unix-socket (path-regex #"^/")))',
      '(allow network-outbound (remote unix-socket (path-regex #"^/")))',
    );
  } else if (opts.allowUnixSockets && opts.allowUnixSockets.length > 0) {
    rules.push("(allow system-socket (socket-domain AF_UNIX))");
    for (const socketPath of opts.allowUnixSockets) {
      const normalizedPath = normalizePathForSandbox(socketPath);
      rules.push(
        `(allow network-bind (local unix-socket (subpath ${escapePath(normalizedPath)})))`,
        `(allow network-outbound (remote unix-socket (subpath ${escapePath(normalizedPath)})))`,
      );
    }
  }
  return rules;
}

export function generateSandboxProfile(opts: SandboxProfileOptions): string {
  const {
    readConfig,
    writeConfig,
    allowMachLookup,
    allowPty,
    allowGitConfig = false,
    enableWeakerNetworkIsolation = false,
    logTag,
  } = opts;
  const profile: string[] = [
    "(version 1)",
    `(deny default (with message "${logTag}"))`,
    "",
    `; LogTag: ${logTag}`,
    "",
    "; Process",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow mach-priv-task-port (target same-sandbox))",
    "",
    "; User preferences",
    "(allow user-preference-read)",
    "",
    "; Mach IPC",
    "(allow mach-lookup",
    '  (global-name "com.apple.audio.systemsoundserver")',
    '  (global-name "com.apple.distributed_notifications@Uv3")',
    '  (global-name "com.apple.FontObjectsServer")',
    '  (global-name "com.apple.fonts")',
    '  (global-name "com.apple.logd")',
    '  (global-name "com.apple.lsd.mapdb")',
    '  (global-name "com.apple.PowerManagement.control")',
    '  (global-name "com.apple.system.logger")',
    '  (global-name "com.apple.system.notification_center")',
    '  (global-name "com.apple.system.opendirectoryd.libinfo")',
    '  (global-name "com.apple.system.opendirectoryd.membership")',
    '  (global-name "com.apple.bsd.dirhelper")',
    '  (global-name "com.apple.securityd.xpc")',
    '  (global-name "com.apple.coreservices.launchservicesd")',
    ")",
    "",
  ];
  if (enableWeakerNetworkIsolation) {
    profile.push(
      "; trustd.agent (weaker network isolation)",
      '(allow mach-lookup (global-name "com.apple.trustd.agent"))',
      "",
    );
  }
  if (allowMachLookup && allowMachLookup.length > 0) {
    profile.push("; User-specified XPC/Mach services");
    for (const name of allowMachLookup) {
      profile.push(
        name.endsWith("*")
          ? `(allow mach-lookup (global-name-prefix ${escapePath(name.slice(0, -1))}))`
          : `(allow mach-lookup (global-name ${escapePath(name)}))`,
      );
    }
    profile.push("");
  }
  profile.push(
    "; POSIX IPC",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    "",
    "; IOKit",
    "(allow iokit-open",
    '  (iokit-registry-entry-class "IOSurfaceRootUserClient")',
    '  (iokit-registry-entry-class "RootDomainUserClient")',
    '  (iokit-user-client-class "IOSurfaceSendRight")',
    ")",
    "(allow iokit-get-properties)",
    "",
    "; Safe system-sockets (no network)",
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "",
    "; sysctl",
    "(allow sysctl-read",
    '  (sysctl-name "hw.activecpu") (sysctl-name "hw.busfrequency_compat")',
    '  (sysctl-name "hw.byteorder") (sysctl-name "hw.cacheconfig")',
    '  (sysctl-name "hw.cachelinesize_compat") (sysctl-name "hw.cpufamily")',
    '  (sysctl-name "hw.cpufrequency") (sysctl-name "hw.cpufrequency_compat")',
    '  (sysctl-name "hw.cputype") (sysctl-name "hw.l1dcachesize_compat")',
    '  (sysctl-name "hw.l1icachesize_compat") (sysctl-name "hw.l2cachesize_compat")',
    '  (sysctl-name "hw.l3cachesize_compat") (sysctl-name "hw.logicalcpu")',
    '  (sysctl-name "hw.logicalcpu_max") (sysctl-name "hw.machine")',
    '  (sysctl-name "hw.memsize") (sysctl-name "hw.ncpu")',
    '  (sysctl-name "hw.nperflevels") (sysctl-name "hw.packages")',
    '  (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.pagesize")',
    '  (sysctl-name "hw.physicalcpu") (sysctl-name "hw.physicalcpu_max")',
    '  (sysctl-name "hw.tbfrequency_compat") (sysctl-name "hw.vectorunit")',
    '  (sysctl-name "kern.argmax") (sysctl-name "kern.bootargs")',
    '  (sysctl-name "kern.hostname") (sysctl-name "kern.iossupportversion")',
    '  (sysctl-name "kern.maxfiles") (sysctl-name "kern.maxfilesperproc")',
    '  (sysctl-name "kern.maxproc") (sysctl-name "kern.ngroups")',
    '  (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease")',
    '  (sysctl-name "kern.ostype") (sysctl-name "kern.osvariant_status")',
    '  (sysctl-name "kern.osversion") (sysctl-name "kern.secure_kernel")',
    '  (sysctl-name "kern.tcsm_available") (sysctl-name "kern.tcsm_enable")',
    '  (sysctl-name "kern.usrstack64") (sysctl-name "kern.version")',
    '  (sysctl-name "kern.willshutdown") (sysctl-name "machdep.cpu.brand_string")',
    '  (sysctl-name "machdep.ptrauth_enabled") (sysctl-name "security.mac.lockdown_mode_state")',
    '  (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg")',
    '  (sysctl-name-prefix "hw.optional.arm") (sysctl-name-prefix "hw.optional.arm.")',
    '  (sysctl-name-prefix "hw.optional.armv8_")',
    '  (sysctl-name-prefix "hw.perflevel") (sysctl-name-prefix "kern.proc.all")',
    '  (sysctl-name-prefix "kern.proc.pgrp.") (sysctl-name-prefix "kern.proc.pid.")',
    '  (sysctl-name-prefix "machdep.cpu.") (sysctl-name-prefix "net.routetable.")',
    ")",
    "",
    "; V8 thread calculations",
    '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
    "",
    "; Distributed notifications",
    "(allow distributed-notification-post)",
    "",
    "; SecurityServer",
    '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
    "",
    "; Device files",
    '(allow file-ioctl (literal "/dev/null"))',
    '(allow file-ioctl (literal "/dev/zero"))',
    '(allow file-ioctl (literal "/dev/random"))',
    '(allow file-ioctl (literal "/dev/urandom"))',
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
    '(allow file-ioctl (literal "/dev/tty"))',
    "(allow file-ioctl file-read-data file-write-data",
    "  (require-all",
    '    (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))',
    "",
  );
  profile.push(...networkRulesFor(opts), "");
  profile.push("; File read");
  profile.push(...generateReadRules(readConfig, logTag, writeConfig?.allowOnly));
  profile.push("", "; File write");
  profile.push(...generateWriteRules(writeConfig, logTag, allowGitConfig));
  if (allowPty) {
    profile.push(
      "",
      "; Pseudo-terminal (pty)",
      "(allow pseudo-tty)",
      "(allow file-ioctl",
      '  (literal "/dev/ptmx") (regex #"^/dev/ttys"))',
      "(allow file-read* file-write*",
      '  (literal "/dev/ptmx") (regex #"^/dev/ttys"))',
    );
  }
  return profile.join("\n");
}

function shellQuote(s: string): string {
  const sanitized = s.replace(/[\x00-\x1F\x7F]/g, "");
  return `'${sanitized.replace(/'/g, "'\\''")}'`;
}

export interface MacOSWrapExtras {
  tmpdir?: string;
}

export function wrapCommandWithSandboxMacOS(
  params: SandboxWrapParams,
  extras: MacOSWrapExtras = {},
): { wrapped: string; logTag: string } | { wrapped: string; logTag: null } {
  const { command, binShell, ...profileOpts } = params;
  const hasReadRestrictions =
    profileOpts.readConfig !== undefined && profileOpts.readConfig.denyOnly.length > 0;
  const hasWriteRestrictions = profileOpts.writeConfig !== undefined;
  if (!profileOpts.needsNetworkRestriction && !hasReadRestrictions && !hasWriteRestrictions) {
    return { wrapped: command, logTag: null };
  }
  const logTag = generateLogTag(command);
  const profile = generateSandboxProfile({ ...profileOpts, logTag });
  const envArgs = ["env", `SANDBOX_RUNTIME=1`, `OTHERSIDE_SANDBOX_LOGTAG=${logTag}`];
  if (extras.tmpdir) {
    envArgs.push(`TMPDIR=${extras.tmpdir}`);
    envArgs.push(`TMPPREFIX=${extras.tmpdir}/zsh`);
  }
  const parts = [
    ...envArgs.map(shellQuote),
    "/usr/bin/sandbox-exec",
    "-p",
    shellQuote(profile),
    shellQuote(binShell),
    "-c",
    shellQuote(command),
  ];
  return { wrapped: parts.join(" "), logTag };
}
