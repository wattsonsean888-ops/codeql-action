import * as os from "os";
import { join } from "path";

import * as actionsCache from "@actions/cache";
import * as glob from "@actions/glob";

import { getTemporaryDirectory } from "./actions-util";
import { getTotalCacheSize } from "./caching-utils";
import { CodeQL } from "./codeql";
import { Config } from "./config-utils";
import { EnvVar } from "./environment";
import { Feature, Features } from "./feature-flags";
import { KnownLanguage, Language } from "./languages";
import { Logger } from "./logging";
import { getRequiredEnvParam } from "./util";

/**
 * Caching configuration for a particular language.
 */
interface CacheConfig {
  /** Gets the paths of directories on the runner that should be included in the cache. */
  getDependencyPaths: () => string[];
  /**
   * Patterns for the paths of files whose contents affect which dependencies are used
   * by a project. We find all files which match these patterns, calculate a hash for
   * their contents, and use that hash as part of the cache key.
   */
  hash: string[];
}

const CODEQL_DEPENDENCY_CACHE_PREFIX = "codeql-dependencies";
const CODEQL_DEPENDENCY_CACHE_VERSION = 1;

/**
 * Returns a path to a directory intended to be used to store .jar files
 * for the Java `build-mode: none` extractor.
 * @returns The path to the directory that should be used by the `build-mode: none` extractor.
 */
export function getJavaTempDependencyDir(): string {
  return join(getTemporaryDirectory(), "codeql_java", "repository");
}

/**
 * Returns an array of paths of directories on the runner that should be included in a dependency cache
 * for a Java analysis. It is important that this is a function, because we call `getTemporaryDirectory`
 * which would otherwise fail in tests if we haven't had a chance to initialise `RUNNER_TEMP`.
 *
 * @returns The paths of directories on the runner that should be included in a dependency cache
 * for a Java analysis.
 */
export function getJavaDependencyDirs(): string[] {
  return [
    // Maven
    join(os.homedir(), ".m2", "repository"),
    // Gradle
    join(os.homedir(), ".gradle", "caches"),
    // CodeQL Java build-mode: none
    getJavaTempDependencyDir(),
  ];
}

/**
 * Default caching configurations per language.
 */
const defaultCacheConfigs: { [language: string]: CacheConfig } = {
  java: {
    getDependencyPaths: getJavaDependencyDirs,
    hash: [
      // Maven
      "**/pom.xml",
      // Gradle
      "**/*.gradle*",
      "**/gradle-wrapper.properties",
      "buildSrc/**/Versions.kt",
      "buildSrc/**/Dependencies.kt",
      "gradle/*.versions.toml",
      "**/versions.properties",
    ],
  },
  csharp: {
    getDependencyPaths: () => [join(os.homedir(), ".nuget", "packages")],
    hash: [
      // NuGet
      "**/packages.lock.json",
      // Paket
      "**/paket.lock",
    ],
  },
  go: {
    getDependencyPaths: () => [join(os.homedir(), "go", "pkg", "mod")],
    hash: ["**/go.sum"],
  },
};

async function makeGlobber(patterns: string[]): Promise<glob.Globber> {
  return glob.create(patterns.join("\n"));
}

/**
 * Attempts to restore dependency caches for the languages being analyzed.
 *
 * @param codeql The CodeQL instance to use.
 * @param features Information about which FFs are enabled.
 * @param languages The languages being analyzed.
 * @param logger A logger to record some informational messages to.
 * @returns A list of languages for which dependency caches were restored.
 */
export async function downloadDependencyCaches(
  codeql: CodeQL,
  features: Features,
  languages: Language[],
  logger: Logger,
): Promise<Language[]> {
  const restoredCaches: Language[] = [];

  for (const language of languages) {
    const cacheConfig = defaultCacheConfigs[language];

    if (cacheConfig === undefined) {
      logger.info(
        `Skipping download of dependency cache for ${language} as we have no caching configuration for it.`,
      );
      continue;
    }

    // Check that we can find files to calculate the hash for the cache key from, so we don't end up
    // with an empty string.
    const globber = await makeGlobber(cacheConfig.hash);

    if ((await globber.glob()).length === 0) {
      logger.info(
        `Skipping download of dependency cache for ${language} as we cannot calculate a hash for the cache key.`,
      );
      continue;
    }

    const primaryKey = await cacheKey(codeql, features, language, cacheConfig);
    const restoreKeys: string[] = [
      await cachePrefix(codeql, features, language),
    ];

    logger.info(
      `Downloading cache for ${language} with key ${primaryKey} and restore keys ${restoreKeys.join(
        ", ",
      )}`,
    );

    const hitKey = await actionsCache.restoreCache(
      cacheConfig.getDependencyPaths(),
      primaryKey,
      restoreKeys,
    );

    if (hitKey !== undefined) {
      logger.info(`Cache hit on key ${hitKey} for ${language}.`);
      restoredCaches.push(language);
    } else {
      logger.info(`No suitable cache found for ${language}.`);
    }
  }

  return restoredCaches;
}

/**
 * Attempts to store caches for the languages that were analyzed.
 *
 * @param codeql The CodeQL instance to use.
 * @param features Information about which FFs are enabled.
 * @param config The configuration for this workflow.
 * @param logger A logger to record some informational messages to.
 */
export async function uploadDependencyCaches(
  codeql: CodeQL,
  features: Features,
  config: Config,
  logger: Logger,
): Promise<void> {
  for (const language of config.languages) {
    const cacheConfig = defaultCacheConfigs[language];

    if (cacheConfig === undefined) {
      logger.info(
        `Skipping upload of dependency cache for ${language} as we have no caching configuration for it.`,
      );
      continue;
    }

    // Check that we can find files to calculate the hash for the cache key from, so we don't end up
    // with an empty string.
    const globber = await makeGlobber(cacheConfig.hash);

    if ((await globber.glob()).length === 0) {
      logger.info(
        `Skipping upload of dependency cache for ${language} as we cannot calculate a hash for the cache key.`,
      );
      continue;
    }

    // Calculate the size of the files that we would store in the cache. We use this to determine whether the
    // cache should be saved or not. For example, if there are no files to store, then we skip creating the
    // cache. In the future, we could also:
    // - Skip uploading caches with a size below some threshold: this makes sense for avoiding the overhead
    //   of storing and restoring small caches, but does not help with alert wobble if a package repository
    //   cannot be reached in a given run.
    // - Skip uploading caches with a size above some threshold: this could be a concern if other workflows
    //   use the cache quota that we compete with. In that case, we do not wish to use up all of the quota
    //   with the dependency caches. For this, we could use the Cache API to check whether other workflows
    //   are using the quota and how full it is.
    const size = await getTotalCacheSize(
      cacheConfig.getDependencyPaths(),
      logger,
      true,
    );

    // Skip uploading an empty cache.
    if (size === 0) {
      logger.info(
        `Skipping upload of dependency cache for ${language} since it is empty.`,
      );
      continue;
    }

    const key = await cacheKey(codeql, features, language, cacheConfig);

    logger.info(
      `Uploading cache of size ${size} for ${language} with key ${key}...`,
    );

    try {
      await actionsCache.saveCache(cacheConfig.getDependencyPaths(), key);
    } catch (error) {
      // `ReserveCacheError` indicates that the cache key is already in use, which means that a
      // cache with that key already exists or is in the process of being uploaded by another
      // workflow. We can ignore this.
      if (error instanceof actionsCache.ReserveCacheError) {
        logger.info(
          `Not uploading cache for ${language}, because ${key} is already in use.`,
        );
        logger.debug(error.message);
      } else {
        // Propagate other errors upwards.
        throw error;
      }
    }
  }
}

/**
 * Computes a cache key for the specified language.
 *
 * @param codeql The CodeQL instance to use.
 * @param features Information about which FFs are enabled.
 * @param language The language being analyzed.
 * @param cacheConfig The cache configuration for the language.
 * @returns A cache key capturing information about the project(s) being analyzed in the specified language.
 */
async function cacheKey(
  codeql: CodeQL,
  features: Features,
  language: Language,
  cacheConfig: CacheConfig,
): Promise<string> {
  const hash = await glob.hashFiles(cacheConfig.hash.join("\n"));
  return `${await cachePrefix(codeql, features, language)}${hash}`;
}

/**
 * Constructs a prefix for the cache key, comprised of a CodeQL-specific prefix, a version number that
 * can be changed to invalidate old caches, the runner's operating system, and the specified language name.
 *
 * @param codeql The CodeQL instance to use.
 * @param features Information about which FFs are enabled.
 * @param language The language being analyzed.
 * @returns The prefix that identifies what a cache is for.
 */
async function cachePrefix(
  codeql: CodeQL,
  features: Features,
  language: Language,
): Promise<string> {
  const runnerOs = getRequiredEnvParam("RUNNER_OS");
  const customPrefix = process.env[EnvVar.DEPENDENCY_CACHING_PREFIX];
  let prefix = CODEQL_DEPENDENCY_CACHE_PREFIX;

  if (customPrefix !== undefined && customPrefix.length > 0) {
    prefix = `${prefix}-${customPrefix}`;
  }

  // To ensure a safe rollout of JAR minimization, we change the key when the feature is enabled.
  const minimizeJavaJars = await features.getValue(
    Feature.JavaMinimizeDependencyJars,
    codeql,
  );
  if (language === KnownLanguage.java && minimizeJavaJars) {
    prefix = `minify-${prefix}`;
  }

  return `${prefix}-${CODEQL_DEPENDENCY_CACHE_VERSION}-${runnerOs}-${language}-`;
}
