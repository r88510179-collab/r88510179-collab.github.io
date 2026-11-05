// QA ONLY — never merge. Loaded as the first module on the QA publisher pages so the origin/target checks and the network
// allowlist are in place before the Neon client library or the publisher script is evaluated.
import {qaPublisherBoot} from './qa-publisher-config.js?v=1';
qaPublisherBoot(globalThis);
