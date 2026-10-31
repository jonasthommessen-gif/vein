import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { VeinProfile } from '../types';

interface Props {
  profile: VeinProfile;
  onBack: () => void;
}

type Tab = 'analysis' | 'palate' | 'advice';

export function DetailsScreen({ profile, onBack }: Props) {
  const [tab, setTab] = useState<Tab>('analysis');

  return (
    <div className="page">
      <nav className="page-nav">
        <button type="button" className="nav-action" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} strokeWidth={1.5} /> Back
        </button>
      </nav>

      <p className="eyebrow">Details</p>
      <h1 className="library-title" style={{ fontSize: 25 }}>
        Vein class {profile.classCode}
      </h1>

      <div className="tabs" role="tablist">
        {(
          [
            ['analysis', 'Analysis'],
            ['palate', 'Palate'],
            ['advice', 'Advice'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'analysis' && (
        <div className="detail-section">
          <h3>Measured features</h3>
          <ul className="detail-list">
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
              <span>Capture confidence</span>
              <span>{profile.measured.imageConfidence}</span>
            </li>
          </ul>
          <p className="disclosure">
            From visual contrast and texture proxies; not a medical assessment.
          </p>
          <p className="disclosure">Fictional profile · based on visible image characteristics</p>
        </div>
      )}

      {tab === 'palate' && (
        <div className="detail-section">
          <h3>Palate</h3>
          <ul className="detail-list">
            {Object.entries(profile.palateNotes).map(([k, v]) => (
              <li key={k}>
                <span>{k}</span>
                <span>{v}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'advice' && (
        <div className="detail-section">
          <h3>Advice</h3>
          <ul className="advice-list">
            {profile.recommendations.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
