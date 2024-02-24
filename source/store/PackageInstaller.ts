import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { Diagnostic } from "#diagnostic";
import { Environment } from "#environment";
import { EventEmitter } from "#events";
import { Path } from "#path";
import { Lock } from "./Lock.js";

export class PackageInstaller {
  #onDiagnostic: (diagnostic: Diagnostic) => void;
  #readyFileName = "__ready__";
  #storePath: string;
  #timeout = Environment.timeout * 1000;

  constructor(storePath: string, onDiagnostic: (diagnostic: Diagnostic) => void) {
    this.#storePath = storePath;
    this.#onDiagnostic = onDiagnostic;
  }

  async ensure(compilerVersion: string, signal?: AbortSignal): Promise<string | undefined> {
    const installationPath = Path.join(this.#storePath, compilerVersion);
    const readyFilePath = Path.join(installationPath, this.#readyFileName);
    const modulePath = Path.join(installationPath, "node_modules", "typescript", "lib", "typescript.js");

    if (existsSync(readyFilePath)) {
      return modulePath;
    }

    if (
      await Lock.isLocked(installationPath, {
        onDiagnostic: (text) => {
          this.#onDiagnostic(Diagnostic.error([`Failed to install 'typescript@${compilerVersion}'.`, text]));
        },
        signal,
        timeout: this.#timeout,
      })
    ) {
      return;
    }

    const lock = new Lock(installationPath);

    EventEmitter.dispatch(["store:info", { compilerVersion, installationPath }]);

    try {
      await fs.mkdir(installationPath, { recursive: true });

      const packageJson = {
        /* eslint-disable sort-keys */
        name: "tstyche-typescript",
        version: compilerVersion,
        description: "Do not change. This package was generated by TSTyche",
        private: true,
        license: "MIT",
        dependencies: {
          typescript: compilerVersion,
        },
        /* eslint-enable sort-keys */
      };

      await fs.writeFile(Path.join(installationPath, "package.json"), JSON.stringify(packageJson, null, 2));
      await this.#install(installationPath, signal);

      await fs.writeFile(readyFilePath, "");

      return modulePath;
    } catch (error) {
      this.#onDiagnostic(Diagnostic.fromError(`Failed to install 'typescript@${compilerVersion}'.`, error));
    } finally {
      lock.release();
    }

    return;
  }

  async #install(cwd: string, signal?: AbortSignal) {
    const args = ["install", "--ignore-scripts", "--no-bin-links", "--no-package-lock"];

    return new Promise<void>((resolve, reject) => {
      const spawnedNpm = spawn("npm", args, {
        cwd,
        shell: true,
        signal,
        stdio: "ignore",
        timeout: this.#timeout,
      });

      spawnedNpm.on("error", (error) => {
        reject(error);
      });

      spawnedNpm.on("close", (code, signal) => {
        if (code === 0) {
          resolve();
        }

        if (signal != null) {
          reject(new Error(`setup timeout of ${this.#timeout / 1000}s was exceeded`));
        }

        reject(new Error(`process exited with code ${String(code)}`));
      });
    });
  }
}
