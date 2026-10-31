import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import type { VeinProfile } from '../types';
import {
  deleteProfile,
  listProfiles,
  renameProfile,
} from '../persistence/profiles';

interface Props {
  onBack: () => void;
  onOpen: (profile: VeinProfile) => void;
}

export function LibraryScreen({ onBack, onOpen }: Props) {
  const [profiles, setProfiles] = useState<VeinProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await listProfiles();
      setProfiles(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="page">
      <nav className="page-nav">
        <button type="button" className="nav-action" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} strokeWidth={1.5} /> Back
        </button>
      </nav>

      <h1 className="library-title">Saved profiles</h1>

      {loading ? (
        <p className="library-empty">Loading…</p>
      ) : profiles.length === 0 ? (
        <p className="library-empty">No saved profiles yet. Complete an analysis and tap Save.</p>
      ) : (
        <ul className="library-list">
          {profiles.map((p) => {
            const date = new Date(p.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className="library-item"
                  onClick={() => onOpen(p)}
                >
                  {p.captureImage ? (
                    <img
                      className="library-thumb"
                      src={p.captureImage}
                      alt=""
                      width={48}
                      height={48}
                    />
                  ) : null}
                  <div className="library-item-body">
                    <p className="library-item-title">{p.label}</p>
                    <p className="library-item-meta">
                      {date} · {p.classCode} · {p.scores.desirability}
                    </p>
                  </div>
                  <ChevronRight size={18} strokeWidth={1.5} color="#949CA1" />
                </button>

                <div className="library-item-actions">
                  <button
                    type="button"
                    className="nav-action muted"
                    onClick={() => {
                      setRenamingId(p.id);
                      setRenameValue(p.label);
                      setConfirmDeleteId(null);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="nav-action muted"
                    aria-label={`Delete ${p.label}`}
                    onClick={() => {
                      setConfirmDeleteId(p.id);
                      setRenamingId(null);
                    }}
                  >
                    <Trash2 size={16} strokeWidth={1.5} />
                  </button>
                </div>

                {renamingId === p.id && (
                  <div>
                    <input
                      className="rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      aria-label="Rename profile"
                    />
                    <div className="confirm-bar">
                      <button
                        type="button"
                        onClick={() => {
                          void renameProfile(p.id, renameValue).then(() => {
                            setRenamingId(null);
                            void refresh();
                          });
                        }}
                      >
                        Save name
                      </button>
                      <button type="button" onClick={() => setRenamingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {confirmDeleteId === p.id && (
                  <div className="confirm-bar">
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        void deleteProfile(p.id).then(() => {
                          setConfirmDeleteId(null);
                          void refresh();
                        });
                      }}
                    >
                      Confirm delete
                    </button>
                    <button type="button" onClick={() => setConfirmDeleteId(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
