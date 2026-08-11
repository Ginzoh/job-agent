import * as remotive from './remotive.js';
import * as remoteok from './remoteok.js';
import * as arbeitnow from './arbeitnow.js';
import * as weworkremotely from './weworkremotely.js';
import * as hackernews from './hackernews.js';
import * as jobindex from './jobindex.js';
import * as jobtech from './jobtech.js';
import * as companyboards from './companyboards.js';
import * as adzuna from './adzuna.js';
import * as francetravail from './francetravail.js';
import * as freework from './freework.js';

export const ALL_SOURCES = [
  companyboards,   // freshest listings — run first
  freework,        // best French freelance/mission source, states real TJMs
  francetravail,   // best French coverage (needs a free key)
  adzuna,          // widest FR aggregation (needs a free key)
  remotive,
  remoteok,
  weworkremotely,
  arbeitnow,
  hackernews,
  jobtech,        // Sweden — national job bank, open data, no key
  jobindex,       // Denmark — RSS, no pagination allowed
];
