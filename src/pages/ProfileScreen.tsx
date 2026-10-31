import { useState } from 'react';
import { ChevronLeft, Share, Bookmark } from 'lucide-react';
import type { VeinProfile } from '../types';
import { saveProfile } from '../persistence/profiles';
import { shareOrDownload } from '../sharing/renderCard';
import { RadarChart } from '../components/RadarChart';

interface Props {
  profile: VeinProfile;
  onBack: () => void;
  onOpenDetails: () => void;
  onSaved?: () => void;
}

export function ProfileScreen({ profile, onBack, onOpenDetails, onSaved }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const ok = await saveProfile(profile);
      setSaved(ok);
      if (ok) onSaved?.();
    } finally {
      setSaving(false);
    }
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

  return (
    <div className="page profile-page">
      <nav className="page-nav">
        <div className="nav-left">
          <button type="button" className="nav-action" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} strokeWidth={1.5} /> Back
          </button>
        </div>
        <div className="nav-right">
          <button
            type="button"
            className="nav-action muted"
            onClick={() => void handleSave()}
            aria-label="Save"
            disabled={saving}
          >
            <Bookmark size={18} strokeWidth={1.5} />
            {saved ? 'Saved' : 'Save'}
          </button>
          <button
            type="button"
            className="nav-action muted"
            onClick={() => void handleShare()}
            aria-label="Share"
          >
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
      <p className="descriptor">{profile.assessment || profile.descriptor}</p>

      {profile.limitedConfidence ? (
        <p className="limited-badge">Limited confidence · visual characteristics only</p>
      ) : null}

      {profile.captureImage ? (
        <figure className="profile-capture">
          <img src={profile.captureImage} alt="Captured analysis still" />
        </figure>
      ) : null}

      <hr className="hairline" />

      <div className="desire-block">
        <p className="desire-num">{profile.scores.desirability}</p>
        <p className="desire-label">Desirability / 100</p>
        <p className="desire-interp">{profile.descriptor}</p>
      </div>

      <div className="radar-wrap">
        <RadarChart values={profile.radar} size={280} />
      </div>

      <section className="tasting-block">
        <h2 className="section-label">Tasting notes</h2>
        <ul className="tasting-list">
          {(profile.tastingNotes ?? []).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>

      <div className="why-block">
        <button
          type="button"
          className="why-toggle"
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
        >
          Measured vs fiction
          <span aria-hidden>{detailsOpen ? '−' : '+'}</span>
        </button>
        {detailsOpen ? (
          <div className="why-body measured-fiction">
            <p>{profile.why}</p>
            <ul className="detail-list compact">
              <li>
                <span>Vein visibility</span>
                <span>{profile.measured.veinVisibility}</span>
              </li>
              <li>
                <span>Pattern detail</span>
                <span>{profile.measured.patternDetail}</span>
              </li>
              <li>
                <span>Colour signature</span>
                <span>
                  {profile.toneLabel} · {profile.measured.colourSignature}
                </span>
              </li>
              <li>
                <span>Frame stability</span>
                <span>{profile.measured.frameStability}</span>
              </li>
              <li>
                <span>Image confidence</span>
                <span>{profile.measured.imageConfidence}</span>
              </li>
            </ul>
            <p className="disclosure" style={{ marginTop: 12 }}>
              Measured values are image-feature proxies. Desirability, class, tasting notes, and any
              “alcohol signature” jokes are fictional vampire dining theatre — not medical biomarkers.
            </p>
            <button type="button" className="linkish" onClick={onOpenDetails}>
              Open full details →
            </button>
          </div>
        ) : null}
      </div>

      <p className="disclosure">
        Fictional party profile · based on visible image characteristics · not medical advice
      </p>
      {shareNote ? <p className="disclosure">{shareNote}</p> : null}

      <div className="page-actions">
        <button type="button" className="btn-primary" onClick={() => void handleSave()}>
          {saved ? 'Saved to library' : 'Save profile'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => void handleShare()}>
          Share
        </button>
      </div>
    </div>
  );
}
