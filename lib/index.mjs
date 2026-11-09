/**
 * Programmatic surface for flake-ledger.
 *
 * The CLI is the primary interface, but keeping the scanner and parsers
 * importable makes it easy to embed the ledger in a larger CI report without
 * shelling out.
 */
export {
  ScanError,
  discoverJUnitFiles,
  groupFilesByRun,
  scanRuns,
} from './scan.mjs';
export { parseJUnit, parseJUnitFileContents } from './junit.mjs';
export { parseXml, XmlParseError, decodeEntities, localName, textContent } from './xml.mjs';
export {
  FLAKY_CLASSIFICATIONS,
  flakyTests,
  formatExplain,
  formatGithubAnnotations,
  formatPercent,
  formatTable,
  isFlaky,
  toJson,
} from './report.mjs';
