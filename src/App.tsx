import { useState } from 'react';
import { ScannerScreen } from './pages/ScannerScreen';
import { ProfileScreen } from './pages/ProfileScreen';
import { DetailsScreen } from './pages/DetailsScreen';
import { LibraryScreen } from './pages/LibraryScreen';
import type { AppPhase, VeinProfile } from './types';
import './styles/tokens.css';
import './styles/app.css';

type View = Extract<AppPhase, 'INTRO' | 'PROFILE' | 'DETAILS' | 'LIBRARY'> | 'SCANNER';

export default function App() {
  const [view, setView] = useState<View>('SCANNER');
  const [profile, setProfile] = useState<VeinProfile | null>(null);
  const [scannerKey, setScannerKey] = useState(0);

  if (view === 'LIBRARY') {
    return (
      <div className="app">
        <LibraryScreen
          onBack={() => setView(profile ? 'PROFILE' : 'SCANNER')}
          onOpen={(p) => {
            setProfile(p);
            setView('PROFILE');
          }}
        />
      </div>
    );
  }

  if (view === 'DETAILS' && profile) {
    return (
      <div className="app">
        <DetailsScreen profile={profile} onBack={() => setView('PROFILE')} />
      </div>
    );
  }

  if (view === 'PROFILE' && profile) {
    return (
      <div className="app">
        <ProfileScreen
          profile={profile}
          onBack={() => {
            setView('SCANNER');
            setScannerKey((k) => k + 1);
          }}
          onOpenDetails={() => setView('DETAILS')}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <ScannerScreen
        key={scannerKey}
        onOpenLibrary={() => setView('LIBRARY')}
        onProfileReady={(p) => {
          setProfile(p);
          setView('PROFILE');
        }}
      />
    </div>
  );
}
