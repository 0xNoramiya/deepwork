import { useEffect, useState } from 'react';
import type { Artifact } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useStore } from '../store.ts';
import { face, money, tokens } from '../util.ts';
import { ArtifactBody } from './ArchivePanel.tsx';

export function HaulModal() {
  const run = useStore((s) => s.run);
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const artifacts = useStore((s) => s.artifacts);
  const set = useStore((s) => s.set);
  const showArtifact = useStore((s) => s.showArtifact);
  const [final, setFinal] = useState<{ artifact: Artifact; content: string } | null>(null);
  const [finalError, setFinalError] = useState<string | null>(null);

  useEffect(() => {
    if (!run?.finalArtifactId) return;
    api
      .get<{ artifact: Artifact; content: string }>(`/api/artifacts/${run.finalArtifactId}`)
      .then(setFinal)
      .catch((e) => setFinalError(errorMessage(e)));
  }, [run?.finalArtifactId]);

  if (!run || run.status !== 'completed') return null;
  const files = artifacts.filter((a) => a.runId === run.id);
  const crew = [...new Set(tasks.map((t) => t.assigneeId))].flatMap((id) => agents.filter((a) => a.id === id));
  const minutes = Math.max(1, Math.round(((run.finishedAt ?? Date.now()) - run.createdAt) / 60000));
  const close = () => set({ haulOpen: false });

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal haul" role="dialog" aria-modal="true" aria-label="Mission complete" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="icon-btn close" onClick={close} aria-label="Close">
          <Icon name="x" />
        </button>
        <p className="eyebrow">Surfaced · mission complete</p>
        <h2>{run.goal}</h2>
        {run.demo && <p className="callout warn small">Some or all of this came from demo mode. The coordination was real; the text is a template, not a model's writing.</p>}
        <p className="summary">{run.summary}</p>
        <div className="haul-stats">
          <span>{tasks.filter((t) => t.status === 'done').length} tasks</span>
          <span>{files.length} files</span>
          <span>{money(run.spentUsd)}</span>
          <span>{tokens(run.tokensIn + run.tokensOut)} tokens</span>
          <span>{minutes} min</span>
          <span className="faces">
            {crew.map((a) => (
              <img key={a.id} src={face(a)} alt={a.name} title={a.name} />
            ))}
          </span>
        </div>
        {finalError && <p className="warn-text">Couldn't load the final report: {finalError}</p>}
        {final && (
          <div className="haul-doc">
            <ArtifactBody artifact={final.artifact} content={final.content} />
          </div>
        )}
        <div className="row modal-actions">
          {run.finalArtifactId && (
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                close();
                showArtifact(run.finalArtifactId);
              }}
            >
              Open in the archive
            </button>
          )}
          <a className="btn" href={run.finalArtifactId ? `/api/artifacts/${run.finalArtifactId}/download` : undefined} download>
            <Icon name="download" /> Download
          </a>
          <button type="button" className="btn ghost" onClick={close}>
            Back to the sub
          </button>
        </div>
      </div>
    </div>
  );
}
