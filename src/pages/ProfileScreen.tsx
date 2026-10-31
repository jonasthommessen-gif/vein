import { useState } from 'react';
import { ChevronLeft, Share, Bookmark } from 'lucide-react';
import type { VeinProfile } from '../types';
import { saveProfile } from '../persistence/profiles';
import { shareOrDownload } from '../sharing/renderCard';

interface Props {
  profile: VeinProfile;
  onBack: () => void;
  onOpenDetails: () => void;
  onSaved?: () => void;
}

export function ProfileScreen({ profile, onBack, onOpenDetails, onSaved }: Props) {
  const [whyOpen, setWhyOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const handleSave = () => {
    const ok = saveProfile(profile);
    setSaved(ok);
    if (ok) onSaved?.();
  };

  const handleShare = async () => {
    try {
      const mode = await shareOrDownload(profile);
      setShareNote(mode === 'shared' ? 'Shared' : 'PNG downloaded');
    } catch {
      setShareNote('Share unavailable');
    }
  };

  const date = new Date(profile.createdAt);
  const stamp = date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const grid: [string, number][] = [
    ['Clarity', profile.scores.clarity],
    ['Complexity', profile.scores.complexity],
    ['Tone', profile.scores.tone],
    ['Consistency', profile.scores.consistency],
    ['Rarity', profile.scores.rarity],
    ['Nocturnal suitability', profile.scores.nocturnal],
  ];

  return (
    <div className="page">
      <nav className="page-nav">
        <div className="nav-left">
          <button type="button" className="nav-action" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} strokeWidth={1.5} /> Back
          </button>
        </div>
        <div className="nav-right">
          <button type="button" className="nav-action muted" onClick={handleSave} aria-label="Save">
            <Bookmark size={18} strokeWidth={1.5} />
            {saved ? 'Saved' : 'Save'}
          </button>
          <button type="button" className="nav-action muted" onClick={() => void handleShare()} aria-label="Share">
            <Share size={18} strokeWidth={1.5} />
            Share
          </button>
        </div>
      </nav>

      <p className="eyebrow">Blood profile</p>
      <p className="meta-line">
        {profile.label} · {stamp}
      </p>

      <h1 className="hero-class">Vein class {profile.classCode}</h1>
      <p className="verdict">{profile.verdict}</p>
      <p className="descriptor">{profile.descriptor}</p>

      {profile.limitedConfidence ? (
        <p className="limited-badge">Limited confidence · visual characteristics only</p>
      ) : null}

      <hr className="hairline" />

      <div className="desire-block">
        <p className="desire-num">{profile.scores.desirability}</p>
        <p className="desire-label">Desirability / 100</p>
      </div>

      <div className="score-grid">
        {grid.map(([label, value]) => (
          <div className="score-row" key={label}>
            <div className="score-row-top">
              <span>{label}</span>
              <span>{value}</span>
            </div>
            <div className="score-track">
              <div className="score-fill" style={{ width: `${value}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="why-block">
        <button type="button" className="why-toggle" onClick={() => setWhyOpen((v) => !v)}>
          Why this profile?
          <span aria-hidden>{whyOpen ? '−' : '+'}</span>
        </button>
        {whyOpen ? <p className="why-body">{profile.why}</p> : null}
      </div>

      <p className="disclosure">Fictional profile · based on visible image characteristics</p>
      {shareNote ? <p className="disclosure">{shareNote}</p> : null}

      <div className="page-actions">
        <button type="button" className="btn-primary" onClick={onOpenDetails}>
          Detailed analysis
        </button>
        <button type="button" className="btn-secondary" onClick={handleSave}>
          {saved ? 'Saved to library' : 'Save profile'}
        </button>
      </div>
    </div>
  );
}
