import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CoverageHealth,
  TaskAnalysisResponse,
  WorkItem,
  WorkItemsResponse,
} from '@session-radar/shared';
import type { ConnectionState } from './api.js';
import {
  fetchWorkItems,
  openEventStream,
  requestTaskAnalysis,
  setSeen,
} from './api.js';
import {
  actionGroup,
  absoluteTime,
  contextLabel,
  coverageIsHealthy,
  coverageSummary,
  displayTitle,
  entryActions,
  evidenceReason,
  humanTaskState,
  PROVIDER_LABELS,
  recommendedNextStep,
  relativeTime,
  sourceBadges,
  taskSummary,
  webExtensionReloadRequired,
} from './format.js';
import type { ActionGroup } from './format.js';

type StatusFilter = 'all' | 'action_needed' | 'running' | 'done_review' | 'stale_unknown';

interface Filters {
  status: StatusFilter;
  provider: string;
  surface: string;
  repo: string;
  within: string;
  hideSeen: boolean;
}

const EMPTY_FILTERS: Filters = {
  status: 'all',
  provider: 'all',
  surface: 'all',
  repo: '',
  within: '7d',
  hideSeen: false,
};

const WITHIN_OPTIONS: { value: string; label: string; ms: number }[] = [
  { value: '7d', label: 'Active + last 7 days', ms: Number.POSITIVE_INFINITY },
  { value: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { value: '4h', label: 'Last 4 hours', ms: 4 * 60 * 60_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { value: 'indexed', label: 'All indexed history', ms: Number.POSITIVE_INFINITY },
];

/** Product order: action first, active work, review queue, then uncertainty/history. */
const GROUPS: { bucket: ActionGroup; label: string }[] = [
  { bucket: 'attention', label: 'Needs attention' },
  { bucket: 'running', label: 'Running' },
  { bucket: 'done_review', label: 'Done—review needed' },
  { bucket: 'stale_unknown', label: 'Stale or status unknown' },
  { bucket: 'acknowledged', label: 'Acknowledged history' },
];

export function App(): JSX.Element {
  const [data, setData] = useState<WorkItemsResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [now, setNow] = useState(() => Date.now());
  const latestRequest = useRef(0);
  const allIndexed = filters.within === 'indexed';

  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++latestRequest.current;
    try {
      const next = await fetchWorkItems({
        history: allIndexed ? 'all' : 'recent',
        signal,
      });
      if (request !== latestRequest.current || signal?.aborted) return;
      setData(next);
      setError(undefined);
    } catch (cause) {
      if (request !== latestRequest.current || signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [allIndexed]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const close = openEventStream({
      onChange: () => void load(controller.signal),
      onState: setConnection,
    });
    // Relative timestamps drift; re-render them without refetching.
    const tick = setInterval(() => setNow(Date.now()), 20_000);
    // Belt and braces: if SSE silently dies, the list still refreshes.
    const poll = setInterval(() => void load(controller.signal), 30_000);
    return () => {
      controller.abort();
      close();
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [load]);

  const items = data?.items ?? [];
  const connectors = data?.coverage.connectors ?? [];

  const counts = useMemo(
    () => ({
      action_needed: items.filter((i) => actionGroup(i) === 'attention').length,
      done: items.filter((i) => i.status === 'done' && i.attention === 'unseen').length,
      stale: items.filter((i) => actionGroup(i) === 'stale_unknown').length,
      running: items.filter((i) => i.status === 'running').length,
    }),
    [items],
  );

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      const label = contextLabel(item);
      if (label) set.add(label);
    }
    return [...set].sort();
  }, [items]);

  const providers = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) set.add(item.provider);
    for (const connector of connectors) {
      if (connector.provider) set.add(connector.provider);
    }
    return [...set].sort((left, right) =>
      (PROVIDER_LABELS[left] ?? left).localeCompare(PROVIDER_LABELS[right] ?? right),
    );
  }, [items, connectors]);

  const visible = useMemo(() => applyFilters(items, filters, now), [items, filters, now]);

  const grouped = useMemo(() => {
    return GROUPS.map((group) => ({
      ...group,
      items: visible.filter((item) => actionGroup(item) === group.bucket),
    })).filter((group) => group.items.length > 0);
  }, [visible]);

  const onSeen = useCallback(
    async (item: WorkItem) => {
      // Optimistic: acknowledging must feel instant, and the SSE refetch will
      // correct us if the write failed.
      setData((current) =>
        current
          ? {
              ...current,
              items: current.items.map((i) =>
                i.id === item.id
                  ? { ...i, attention: i.attention === 'seen' ? 'unseen' : 'seen' }
                  : i,
              ),
            }
          : current,
      );
      await setSeen(item.id, item.attention !== 'seen');
      void load();
    },
    [load],
  );

  const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  if (!data && !error) {
    return (
      <div className="app">
        <div className="loading">Loading…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="masthead">
        <div className="wordmark">
          session-radar <span>· what needs you</span>
        </div>
        <div className="masthead-right">
          <span className="live">
            <span
              className={`live-dot ${connection === 'live' ? '' : connection === 'connecting' ? 'stale-conn' : 'dead'}`}
            />
            {connection === 'live' ? 'live' : connection === 'connecting' ? 'connecting' : 'reconnecting'}
          </span>
        </div>
      </header>

      {error && (
        <div className="coverage alarm">
          <div className="coverage-head">Cannot reach the daemon — {error}</div>
        </div>
      )}

      <div className="counts">
        <CountCard
          className="needs"
          n={counts.action_needed}
          label="Needs attention"
          active={filters.status === 'action_needed'}
          hot={counts.action_needed > 0}
          onClick={() => toggleStatus('action_needed')}
        />
        <CountCard
          className="running"
          n={counts.running}
          label="Running"
          active={filters.status === 'running'}
          onClick={() => toggleStatus('running')}
        />
        <CountCard
          className="done"
          n={counts.done}
          label="Done · review"
          active={filters.status === 'done_review'}
          onClick={() => toggleStatus('done_review')}
        />
        <CountCard
          className="stale"
          n={counts.stale}
          label="Stale / unknown"
          active={filters.status === 'stale_unknown'}
          onClick={() => toggleStatus('stale_unknown')}
        />
      </div>

      {webExtensionReloadRequired(connectors) && (
        <aside className="setup-callout" role="alert">
          <div className="setup-callout-label">One manual step · web history incomplete</div>
          <div>
            Open <code>chrome://extensions</code>, find <strong>session-radar</strong> and click{' '}
            <strong>Reload</strong>. Then refresh one ChatGPT tab and one Claude tab. Chrome does
            not allow this protected-page action to be automated.
          </div>
        </aside>
      )}

      <CoverageStrip connectors={connectors} />

      <div className="filters">
        <select
          value={filters.provider}
          onChange={(e) => setFilters({ ...filters, provider: e.target.value })}
          aria-label="Filter by provider"
        >
          <option value="all">All providers</option>
          {providers.map((provider) => (
            <option key={provider} value={provider}>
              {PROVIDER_LABELS[provider] ?? provider}
            </option>
          ))}
        </select>
        <select
          value={filters.surface}
          onChange={(e) => setFilters({ ...filters, surface: e.target.value })}
          aria-label="Filter by surface"
        >
          <option value="all">All surfaces</option>
          <option value="cli">CLI</option>
          <option value="web">Web</option>
          <option value="extension">Browser</option>
          <option value="desktop">Desktop</option>
          <option value="mobile">Mobile</option>
        </select>
        <select
          value={filters.repo}
          onChange={(e) => setFilters({ ...filters, repo: e.target.value })}
          aria-label="Filter by repo"
        >
          <option value="">All repos</option>
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
        <select
          value={filters.within}
          onChange={(e) => setFilters({ ...filters, within: e.target.value })}
          aria-label="Filter by last activity"
        >
          {WITHIN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <label className="badge" style={{ cursor: 'pointer', padding: '4px 8px' }}>
          <input
            type="checkbox"
            checked={filters.hideSeen}
            onChange={(e) => setFilters({ ...filters, hideSeen: e.target.checked })}
            style={{ marginRight: 5 }}
          />
          Hide acknowledged done / unknown
        </label>
        {filtersActive && (
          <button className="filter-clear" onClick={() => setFilters(EMPTY_FILTERS)}>
            clear filters
          </button>
        )}
        <span className="result-count">
          {visible.length} of {items.length} {allIndexed ? 'indexed' : 'triage'}
        </span>
      </div>

      {allIndexed && (
        <div className="history-note" role="note">
          This is the local ledger, including older and vendor-archived sessions successfully
          backfilled by collectors. Vendor cache limits or parse warnings in Coverage remain
          genuine gaps.
        </div>
      )}

      {grouped.length === 0 ? (
        <div className="empty">
          <strong>
            {items.length === 0
              ? allIndexed
                ? 'No sessions in the local ledger'
                : 'No sessions in the history window'
              : 'Nothing matches these filters'}
          </strong>
          {items.length === 0 && !coverageIsHealthy(connectors)
            ? 'Some collectors are not reporting — check coverage above before trusting this.'
            : allIndexed
              ? 'Sessions appear here after a connector has indexed them.'
              : 'Active work and sessions touched in the last 7 days appear here.'}
        </div>
      ) : (
        grouped.map((group) => (
          <section key={group.bucket}>
            <h2 className="group-label">
              {group.label} · {group.items.length}
            </h2>
            <div className="items">
              {group.items.map((item) => (
                <ItemRow key={item.id} item={item} now={now} onSeen={onSeen} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );

  function toggleStatus(status: Exclude<StatusFilter, 'all'>): void {
    setFilters((current) => ({
      ...current,
      status: current.status === status ? 'all' : status,
    }));
  }
}

function applyFilters(items: readonly WorkItem[], filters: Filters, now: number): WorkItem[] {
  const within = WITHIN_OPTIONS.find((o) => o.value === filters.within)?.ms ?? Number.POSITIVE_INFINITY;
  return items.filter((item) => {
    if (
      filters.status !== 'all' &&
      !(
        (filters.status === 'action_needed' && actionGroup(item) === 'attention') ||
        (filters.status === 'running' && actionGroup(item) === 'running') ||
        (filters.status === 'done_review' && actionGroup(item) === 'done_review') ||
        (filters.status === 'stale_unknown' && actionGroup(item) === 'stale_unknown')
      )
    ) {
      return false;
    }
    if (filters.provider !== 'all' && item.provider !== filters.provider) return false;
    if (
      filters.surface !== 'all' &&
      !item.entryPoints.some((entry) => entry.source.surface === filters.surface)
    ) {
      return false;
    }
    if (filters.repo && contextLabel(item) !== filters.repo) return false;
    if (now - item.lastActivityAt > within) return false;
    if (
      filters.hideSeen &&
      item.attention === 'seen' &&
      (item.status === 'done' || item.status === 'stale')
    ) {
      return false;
    }
    return true;
  });
}

function CountCard(props: {
  className: string;
  n: number;
  label: string;
  active: boolean;
  hot?: boolean;
  onClick(): void;
}): JSX.Element {
  return (
    <button
      className={`count ${props.className}${props.hot ? ' hot' : ''}`}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      <div className="n">{props.n}</div>
      <div className="label">{props.label}</div>
    </button>
  );
}

function CoverageStrip({ connectors }: { connectors: readonly CoverageHealth[] }): JSX.Element {
  const healthy = coverageIsHealthy(connectors);
  // Problems are expanded by default. A coverage hole you have to click to see
  // is a coverage hole you will miss.
  const [open, setOpen] = useState(!healthy);
  useEffect(() => setOpen(!healthy), [healthy]);

  return (
    <div className={`coverage${healthy ? '' : ' alarm'}`}>
      <button className="coverage-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{open ? '▾' : '▸'}</span>
        <span>Coverage</span>
        <span className="coverage-summary">{coverageSummary(connectors)}</span>
      </button>
      {open && (
        <ul className="coverage-list">
          {connectors.map((connector) => (
            <li key={connector.connectorId} className="coverage-row">
              <span className={`chip ${connector.state}`}>{connector.state}</span>
              <span className="name">
                {connector.displayName}
                {connector.observedSessionCount + connector.archivedSessionCount > 0 && (
                  <span className="coverage-count">
                    {' '}
                    · {connector.observedSessionCount}
                    {connector.archivedSessionCount > 0
                      ? ` +${connector.archivedSessionCount} older/archived`
                      : ''}
                  </span>
                )}
              </span>
              <span className="why">{connector.lastError ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ItemRow({
  item,
  now,
  onSeen,
}: {
  item: WorkItem;
  now: number;
  onSeen(item: WorkItem): void;
}): JSX.Element {
  const [copied, setCopied] = useState<string | undefined>();
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysis, setAnalysis] = useState<TaskAnalysisResponse | undefined>();
  const [analysisError, setAnalysisError] = useState<string | undefined>();
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const context = contextLabel(item);
  const summary = taskSummary(item);
  const actions = entryActions(item);
  const confidence = item.currentEvidence?.confidence;
  const state = humanTaskState(item);
  const stateClass =
    state === 'Waiting for you' || state === 'Needs attention'
      ? 'human-attention'
      : state === 'Done—review needed'
        ? 'human-done'
        : state === 'Status unknown'
          ? 'human-unknown'
          : `human-${state.toLowerCase()}`;

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(undefined), 1500);
    } catch {
      // Clipboard can be blocked; the title attribute still shows the command.
    }
  };

  const analyze = async (): Promise<void> => {
    setAnalysisLoading(true);
    setAnalysisError(undefined);
    try {
      setAnalysis(
        await requestTaskAnalysis(item.id, [
          'final_conclusion',
          'unresolved_items',
          'code_change_summary',
        ]),
      );
    } catch (cause) {
      setAnalysisError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAnalysisLoading(false);
    }
  };

  return (
    <article
      className={`item ${item.status} ${stateClass}${item.attention === 'seen' ? ' seen' : ''}`}
    >
      <div className="rail" />
      <div className="item-main">
        <div className="item-title">{displayTitle(item)}</div>
        {summary && <div className="item-summary">{summary}</div>}
        <div className="item-meta">
          {context && <span className="badge">{context}</span>}
          <span title={absoluteTime(item.lastActivityAt)}>{relativeTime(item.lastActivityAt, now)}</span>
        </div>
        <div className="card-state">
          <span className="status-tag">{state}</span>
          <span className="state-reason">{evidenceReason(item)}</span>
        </div>
        <div className="next-step">
          <span>Next:</span> {recommendedNextStep(item)}
        </div>

        {analysisOpen && (
          <div className="analysis-panel">
            <div className="analysis-title">Analyze this task · per-task permission</div>
            {!analysis && (
              <>
                <p>
                  This requests only a final conclusion, unresolved items, and a code-change
                  summary. It does not authorize bulk history access or full-chat storage.
                </p>
                <button
                  className="action primary"
                  onClick={() => void analyze()}
                  disabled={analysisLoading}
                >
                  {analysisLoading ? 'Checking authorized access…' : 'Authorize limited analysis'}
                </button>
              </>
            )}
            {analysisError && <p className="analysis-error">{analysisError}</p>}
            {analysis && (
              <div className={`analysis-result ${analysis.status}`}>
                <strong>{analysis.message}</strong>
                {analysis.evidence.map((entry) => (
                  <p key={`${entry.source}:${entry.claim}`}>
                    Evidence: {entry.claim} <span>({entry.confidence} confidence)</span>
                  </p>
                ))}
                {analysis.uncertainties.map((uncertainty) => (
                  <p key={uncertainty}>Uncertainty: {uncertainty}</p>
                ))}
                <p className="privacy-result">
                  Accessed fields:{' '}
                  {analysis.accessedFields.length === 0
                    ? 'none'
                    : analysis.accessedFields.join(', ')}
                  {' · '}Full conversation read:{' '}
                  {analysis.privacy.fullConversationRead ? 'yes' : 'no'} · stored:{' '}
                  {analysis.privacy.fullConversationStored ? 'yes' : 'no'}
                </p>
              </div>
            )}
          </div>
        )}

        <details className="technical-details">
          <summary>Technical evidence</summary>
          <div>
            Rule: <code>{item.currentEvidence?.rule ?? 'unknown'}</code> · confidence:{' '}
            <code className={confidence === 'low' ? 'confidence-low' : ''}>
              {confidence ?? 'unknown'}
            </code>
          </div>
          <div>Observed via: {sourceBadges(item).join(', ') || 'unknown source'}</div>
          {item.entryPoints.map((entry) => (
            <div key={entry.id}>
              Source reference: <code>{entry.externalId}</code>
            </div>
          ))}
        </details>
      </div>
      <div className="item-actions">
        {actions.map((action) =>
          action.kind === 'link' ? (
            <a
              key={action.value}
              className="action primary"
              href={action.value}
              target="_blank"
              rel="noreferrer"
            >
              {action.label}
            </a>
          ) : action.kind === 'copy' ? (
            <button
              key={action.value}
              className={`action${copied === action.value ? ' copied' : ''}`}
              onClick={() => void copy(action.value)}
              title={action.value}
            >
              {copied === action.value ? 'Copied' : action.label}
            </button>
          ) : (
            <span key={action.value} className="locate" title={action.value}>
              <strong>{action.label}:</strong> {action.value}
            </span>
          ),
        )}
        <button className="action" onClick={() => setAnalysisOpen((open) => !open)}>
          {analysisOpen ? 'Close analysis' : 'Analyze this task'}
        </button>
        {(item.status === 'done' || item.status === 'stale') && (
          <button className="action" onClick={() => onSeen(item)}>
            {item.attention === 'seen' ? 'Unacknowledge' : 'Acknowledge'}
          </button>
        )}
      </div>
    </article>
  );
}
