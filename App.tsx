import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
  Linking,
  Platform,
  Vibration,
  Modal,
  ActivityIndicator,
  RefreshControl,
  SafeAreaView,
  StatusBar
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Sound from 'react-native-sound';
import axios from 'axios';

// Standard Production URL (immer erreichbar)
const DEFAULT_API_URL = 'https://femboysupportnetwork-ev.de/api';

// Alarm-Sound URL (lauter Signalton / Sirene)
const ALARM_SOUND_URL = 'https://cdn.freesound.org/previews/316/316847_4939433-lq.mp3';

// Storage Keys
const STORAGE_TOKEN = '@fsn_token';
const STORAGE_USER = '@fsn_user';
const STORAGE_CREDS = '@fsn_credentials';
const STORAGE_API_URL = '@fsn_api_url';

// Audio-Kategorie auf Playback setzen (spielt auch bei Stummschaltung/Silent-Switch)
Sound.setCategory('Playback', true);

interface Job {
  id: string;
  creatorName?: string;
  status: 'Offen' | 'In Bearbeitung' | 'Geschlossen';
  reason: string;
  callerName: string;
  callerAge: string;
  callerAddress: string;
  requiresOnSite: boolean;
  createdAt: number;
  assignedMember?: {
    member: {
      id?: string;
      name?: string;
      email?: string;
      phone?: string;
      role?: string;
    };
    distance?: number;
  } | null;
}

export default function App() {
  // Auth State
  const [apiUrl, setApiUrl] = useState<string>(DEFAULT_API_URL);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [isInitializing, setIsInitializing] = useState<boolean>(true);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  // Form State
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

  // Dispatcher State
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeTab, setActiveTab] = useState<'my' | 'all'>('my');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Emergency Alarm State
  const [activeAlarmJob, setActiveAlarmJob] = useState<Job | null>(null);
  const [isAlarmPlaying, setIsAlarmPlaying] = useState<boolean>(false);

  // Settings Modal State
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [customApiUrl, setCustomApiUrl] = useState(DEFAULT_API_URL);

  // Refs
  const alarmSoundRef = useRef<Sound | null>(null);
  const knownAssignedJobIds = useRef<Set<string>>(new Set());
  const isInitialFetch = useRef<boolean>(true);
  const tokenRef = useRef<string | null>(null);
  const userRef = useRef<any>(null);
  const apiUrlRef = useRef<string>(DEFAULT_API_URL);

  // Synchronisiere Refs für Polling-Intervall
  useEffect(() => {
    tokenRef.current = token;
    userRef.current = user;
    apiUrlRef.current = apiUrl;
  }, [token, user, apiUrl]);

  // Initialisierung: Sound laden & gespeicherten Login wiederherstellen
  useEffect(() => {
    // Alarm-Sound vorab in den Speicher laden
    const soundInstance = new Sound(ALARM_SOUND_URL, undefined, (error) => {
      if (error) {
        console.warn('Fehler beim Laden des Alarm-Sounds:', error);
      } else {
        soundInstance.setVolume(1.0);
      }
    });
    alarmSoundRef.current = soundInstance;

    // Login und API-URL aus Speicher laden
    initializeSession();

    return () => {
      stopAlarm();
      if (alarmSoundRef.current) {
        alarmSoundRef.current.release();
      }
    };
  }, []);

  // Prüft, ob ein Job dem aktuell eingeloggten Benutzer zugewiesen ist
  const isJobAssignedToMe = useCallback((job: Job, currentUser: any): boolean => {
    if (!job || !currentUser || !job.assignedMember || !job.assignedMember.member) {
      return false;
    }
    const member = job.assignedMember.member;

    // Abgleich über ID, Name oder E-Mail
    const idMatches = member.id && currentUser.id && String(member.id) === String(currentUser.id);
    const nameMatches =
      member.name &&
      currentUser.name &&
      member.name.trim().toLowerCase() === currentUser.name.trim().toLowerCase();
    const emailMatches =
      member.email &&
      currentUser.email &&
      member.email.trim().toLowerCase() === currentUser.email.trim().toLowerCase();

    return Boolean(idMatches || nameMatches || emailMatches);
  }, []);

  // Alarm & Vibration starten
  const triggerAlarm = useCallback((job: Job) => {
    setActiveAlarmJob(job);
    setIsAlarmPlaying(true);

    // Vibration im Endlos-Muster (1s vibrieren, 0.5s Pause)
    Vibration.vibrate([1000, 500, 1000, 500], true);

    // Sound abspielen (Endlosschleife bis zum Quittieren)
    if (alarmSoundRef.current) {
      try {
        alarmSoundRef.current.setNumberOfLoops(-1);
        alarmSoundRef.current.setCurrentTime(0);
        alarmSoundRef.current.play((success) => {
          if (!success) {
            console.warn('Alarm-Sound Wiedergabe fehlgeschlagen.');
          }
        });
      } catch (err) {
        console.warn('Fehler beim Abspielen des Sounds:', err);
      }
    }
  }, []);

  // Alarm stoppen & quittieren
  const stopAlarm = useCallback(() => {
    setIsAlarmPlaying(false);
    setActiveAlarmJob(null);
    Vibration.cancel();

    if (alarmSoundRef.current) {
      try {
        alarmSoundRef.current.stop();
      } catch (err) {
        console.warn('Fehler beim Stoppen des Sounds:', err);
      }
    }
  }, []);

  // Test-Alarm Funktion (um Audio & Vibration zu testen)
  const handleTestAlarm = () => {
    const dummyJob: Job = {
      id: 'test-' + Date.now(),
      status: 'In Bearbeitung',
      reason: 'Funktionstest Dispatcher-Alarmierung',
      callerName: 'Test-Meldung',
      callerAge: 'FSN Leitstelle',
      callerAddress: 'Teststraße 1, 10115 Berlin',
      requiresOnSite: true,
      createdAt: Date.now(),
      assignedMember: {
        member: { name: user?.name || 'Du' },
        distance: 0.5
      }
    };
    triggerAlarm(dummyJob);
  };

  // Automatischer Login & Token-Wiederherstellung (1x anmelden reicht)
  const initializeSession = async () => {
    try {
      const [savedUrl, savedToken, savedUser, savedCreds] = await Promise.all([
        AsyncStorage.getItem(STORAGE_API_URL),
        AsyncStorage.getItem(STORAGE_TOKEN),
        AsyncStorage.getItem(STORAGE_USER),
        AsyncStorage.getItem(STORAGE_CREDS)
      ]);

      const activeUrl = savedUrl || DEFAULT_API_URL;
      setApiUrl(activeUrl);
      setCustomApiUrl(activeUrl);

      if (savedToken && savedUser) {
        const parsedUser = JSON.parse(savedUser);
        setToken(savedToken);
        setUser(parsedUser);
        tokenRef.current = savedToken;
        userRef.current = parsedUser;

        // Versuche direkt Jobs zu laden, um Token zu validieren
        const success = await fetchJobs(savedToken, parsedUser, activeUrl);
        if (!success && savedCreds) {
          // Token war eventuell nach 24h abgelaufen -> Auto-Relogin im Hintergrund
          const creds = JSON.parse(savedCreds);
          await performLogin(creds.username, creds.password, activeUrl, false);
        }
      } else if (savedCreds) {
        // Nur Credentials gespeichert -> Auto-Login
        const creds = JSON.parse(savedCreds);
        await performLogin(creds.username, creds.password, activeUrl, false);
      }
    } catch (e) {
      console.warn('Fehler bei Session-Initialisierung:', e);
    } finally {
      setIsInitializing(false);
    }
  };

  // Führt den Login aus und speichert Daten dauerhaft
  const performLogin = async (
    loginUser: string,
    loginPass: string,
    targetUrl: string,
    showAlertOnError = true
  ): Promise<boolean> => {
    try {
      setIsLoggingIn(true);
      const res = await axios.post(
        `${targetUrl}/auth/login`,
        { username: loginUser.trim(), password: loginPass },
        { timeout: 8000 }
      );

      if (res.data && res.data.token && res.data.user) {
        const receivedToken = res.data.token;
        const receivedUser = res.data.user;

        setToken(receivedToken);
        setUser(receivedUser);
        tokenRef.current = receivedToken;
        userRef.current = receivedUser;

        // Dauerhaft in AsyncStorage sichern
        await AsyncStorage.setItem(STORAGE_TOKEN, receivedToken);
        await AsyncStorage.setItem(STORAGE_USER, JSON.stringify(receivedUser));

        if (rememberMe) {
          await AsyncStorage.setItem(
            STORAGE_CREDS,
            JSON.stringify({ username: loginUser.trim(), password: loginPass })
          );
        }

        // Einsätze sofort initialisieren
        isInitialFetch.current = true;
        await fetchJobs(receivedToken, receivedUser, targetUrl);
        return true;
      } else {
        if (showAlertOnError) {
          Alert.alert('Fehler', 'Ungültige Antwort vom Server erhalten.');
        }
        return false;
      }
    } catch (err: any) {
      if (showAlertOnError) {
        if (!err.response) {
          Alert.alert(
            'Verbindungsfehler',
            `Server unter ${targetUrl} nicht erreichbar.\nBitte Internetverbindung oder URL prüfen.`
          );
        } else {
          Alert.alert('Login fehlgeschlagen', err.response?.data?.error || 'Zugangsdaten falsch.');
        }
      }
      return false;
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleManualLogin = async () => {
    if (!username.trim() || !password) {
      Alert.alert('Hinweis', 'Bitte Benutzername/E-Mail und Passwort eingeben.');
      return;
    }
    await performLogin(username, password, apiUrl, true);
  };

  // Abmelden
  const handleLogout = async () => {
    stopAlarm();
    await AsyncStorage.removeItem(STORAGE_TOKEN);
    await AsyncStorage.removeItem(STORAGE_USER);
    await AsyncStorage.removeItem(STORAGE_CREDS);
    setToken(null);
    setUser(null);
    tokenRef.current = null;
    userRef.current = null;
    setJobs([]);
    knownAssignedJobIds.current.clear();
    isInitialFetch.current = true;
  };

  // Jobs vom Server abrufen
  const fetchJobs = async (
    activeToken = tokenRef.current,
    activeUser = userRef.current,
    activeUrl = apiUrlRef.current
  ): Promise<boolean> => {
    if (!activeToken || !activeUser) return false;

    try {
      setIsSyncing(true);
      const res = await axios.get(`${activeUrl}/jobs`, {
        headers: { Authorization: `Bearer ${activeToken}` },
        timeout: 6000
      });

      if (Array.isArray(res.data)) {
        const allJobs: Job[] = res.data;
        setJobs(allJobs);
        setLastSyncTime(new Date());

        // Jobs filtern, die diesem Benutzer zugewiesen sind
        const myAssignedJobs = allJobs.filter(
          (job) => isJobAssignedToMe(job, activeUser) && job.status !== 'Geschlossen'
        );

        if (isInitialFetch.current) {
          // Beim allerersten Laden nur bekannte Jobs merken, OHNE Alarm auszulösen
          knownAssignedJobIds.current = new Set(myAssignedJobs.map((j) => j.id));
          isInitialFetch.current = false;
        } else {
          // Bei jedem weiteren Sync: Prüfen, ob ein NEUER Einsatz zugewiesen wurde
          const newlyAssigned = myAssignedJobs.filter(
            (job) => !knownAssignedJobIds.current.has(job.id)
          );

          if (newlyAssigned.length > 0) {
            // Neuer Einsatz erkannt -> IDs merken und Alarm starten!
            newlyAssigned.forEach((job) => knownAssignedJobIds.current.add(job.id));
            triggerAlarm(newlyAssigned[0]);
          }
        }
        return true;
      }
      return false;
    } catch (err: any) {
      // Wenn 401 oder 403 (Token abgelaufen), versuche Hintergrund-Relogin mit Credentials
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        console.warn('Token abgelaufen, versuche automatisches Re-Login...');
        const savedCreds = await AsyncStorage.getItem(STORAGE_CREDS);
        if (savedCreds) {
          const creds = JSON.parse(savedCreds);
          await performLogin(creds.username, creds.password, activeUrl, false);
        }
      }
      return false;
    } finally {
      setIsSyncing(false);
    }
  };

  // Polling-Intervall: Alle 3 Sekunden synchronisieren
  useEffect(() => {
    let interval: any = null;
    if (token) {
      // Sofort einmal ausführen
      fetchJobs();

      // Regelmäßig synchronisieren (3000ms = 3 Sek für schnelle Alarme)
      interval = setInterval(() => {
        fetchJobs();
      }, 3000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [token]);

  // Pull-to-Refresh
  const onRefresh = async () => {
    setIsRefreshing(true);
    await fetchJobs();
    setIsRefreshing(false);
  };

  // Status eines Jobs aktualisieren (z.B. "In Bearbeitung" oder "Geschlossen")
  const updateJobStatus = async (jobId: string, newStatus: string) => {
    if (!token) return;
    try {
      await axios.put(
        `${apiUrl}/jobs/${jobId}/status`,
        { status: newStatus },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // Lokale Liste aktualisieren
      await fetchJobs();
      if (activeAlarmJob && activeAlarmJob.id === jobId && newStatus === 'In Bearbeitung') {
        stopAlarm();
      }
      Alert.alert('Status aktualisiert', `Einsatzstatus auf "${newStatus}" gesetzt.`);
    } catch (err) {
      Alert.alert('Fehler', 'Konnte Einsatzstatus nicht aktualisieren.');
    }
  };

  // In Karten-App öffnen
  const openMaps = (address: string) => {
    if (!address) return;
    const encodedAddress = encodeURIComponent(address);
    const url =
      Platform.OS === 'ios'
        ? `http://maps.apple.com/?q=${encodedAddress}`
        : `https://www.google.com/maps/search/?api=1&query=${encodedAddress}`;

    Linking.openURL(url).catch(() => {
      Alert.alert('Fehler', 'Karten-App konnte nicht geöffnet werden.');
    });
  };

  // Server-URL speichern
  const saveCustomApiUrl = async () => {
    let formattedUrl = customApiUrl.trim();
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
      formattedUrl = 'https://' + formattedUrl;
    }
    // Entferne trailing slash
    if (formattedUrl.endsWith('/')) {
      formattedUrl = formattedUrl.slice(0, -1);
    }

    setApiUrl(formattedUrl);
    apiUrlRef.current = formattedUrl;
    await AsyncStorage.setItem(STORAGE_API_URL, formattedUrl);
    setSettingsVisible(false);
    Alert.alert('Gespeichert', `Server-URL gesetzt auf:\n${formattedUrl}`);
    if (token) {
      fetchJobs();
    }
  };

  // Gefilterte Jobs nach aktivem Tab
  const myJobs = jobs.filter((job) => isJobAssignedToMe(job, user));
  const displayedJobs = activeTab === 'my' ? myJobs : jobs;

  // 1. Initialer Ladebildschirm (Splash Screen - verhindert Login-Flackern)
  if (isInitializing) {
    return (
      <View style={styles.splashContainer}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.splashIcon}>🚨</Text>
        <Text style={styles.splashTitle}>FSN Dispatcher</Text>
        <Text style={styles.splashSubtitle}>Femboy Support Network e.V.</Text>
        <ActivityIndicator size="large" color="#ffffff" style={{ marginTop: 30 }} />
        <Text style={styles.splashLoadingText}>Synchronisiere Leitstelle...</Text>
      </View>
    );
  }

  // 2. Login-Bildschirm (nur sichtbar, wenn nicht angemeldet)
  if (!token) {
    return (
      <SafeAreaView style={styles.loginContainer}>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.loginScroll}>
          <View style={styles.loginHeader}>
            <Text style={styles.loginBadge}>LEITSTELLE & NOTFALL-EINSATZ</Text>
            <Text style={styles.loginTitle}>FSN Dispatcher</Text>
            <Text style={styles.loginSubtitle}>
              Anmelden für automatische Alarmierung bei Zuweisung
            </Text>
          </View>

          <View style={styles.loginCard}>
            <Text style={styles.inputLabel}>Benutzername oder E-Mail</Text>
            <TextInput
              style={styles.input}
              placeholder="z.B. Jamie oder name@domain.de"
              placeholderTextColor="#999"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>Passwort</Text>
            <TextInput
              style={styles.input}
              placeholder="Dein Dispatcher-Passwort"
              placeholderTextColor="#999"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />

            <TouchableOpacity
              style={styles.loginButton}
              onPress={handleManualLogin}
              disabled={isLoggingIn}
            >
              {isLoggingIn ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.loginButtonText}>Einsatzbereit melden (Login)</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.autoLoginHint}>
              ✓ Bleibt dauerhaft angemeldet für 24/7 Notfall-Alarmierung
            </Text>
          </View>

          {/* Server-URL Button */}
          <TouchableOpacity
            style={styles.serverSettingsBtn}
            onPress={() => setSettingsVisible(true)}
          >
            <Text style={styles.serverSettingsText}>
              ⚙️ Server: {apiUrl.replace('https://', '').replace('http://', '')}
            </Text>
          </TouchableOpacity>
        </ScrollView>

        {/* Server-Einstellungen Modal */}
        <Modal visible={settingsVisible} transparent animationType="slide">
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Server-Einstellungen</Text>
              <Text style={styles.modalSub}>
                Standard: https://femboysupportnetwork-ev.de/api
              </Text>
              <TextInput
                style={styles.modalInput}
                value={customApiUrl}
                onChangeText={setCustomApiUrl}
                placeholder="https://femboysupportnetwork-ev.de/api"
                autoCapitalize="none"
              />
              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnCancel]}
                  onPress={() => setSettingsVisible(false)}
                >
                  <Text style={styles.modalBtnCancelText}>Abbrechen</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnSave]}
                  onPress={saveCustomApiUrl}
                >
                  <Text style={styles.modalBtnSaveText}>Speichern</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // 3. Hauptansicht (Dispatcher Dashboard)
  return (
    <SafeAreaView style={styles.mainContainer}>
      <StatusBar barStyle="light-content" />

      {/* Top Header */}
      <View style={styles.topHeader}>
        <View style={styles.topHeaderLeft}>
          <Text style={styles.topHeaderTitle}>FSN Leitstelle</Text>
          <Text style={styles.topHeaderUser}>
            {user?.name || 'Mitarbeiter'} • {user?.role || 'Einsatzkraft'}
          </Text>
        </View>

        <View style={styles.topHeaderRight}>
          <TouchableOpacity style={styles.testAlarmBtn} onPress={handleTestAlarm}>
            <Text style={styles.testAlarmText}>🔔 Test-Alarm</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Text style={styles.logoutBtnText}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Sync Status Banner */}
      <View style={styles.syncBanner}>
        <View style={styles.syncIndicatorRow}>
          <View style={[styles.syncDot, isSyncing ? styles.syncDotActive : styles.syncDotLive]} />
          <Text style={styles.syncText}>
            {isSyncing
              ? 'Synchronisiere mit Leitstelle...'
              : `Live verbunden • ${lastSyncTime ? lastSyncTime.toLocaleTimeString() : 'Aktiv'}`}
          </Text>
        </View>
        <TouchableOpacity onPress={() => fetchJobs()}>
          <Text style={styles.syncReloadText}>Neu laden ↻</Text>
        </TouchableOpacity>
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'my' && styles.tabButtonActive]}
          onPress={() => setActiveTab('my')}
        >
          <Text style={[styles.tabButtonText, activeTab === 'my' && styles.tabButtonTextActive]}>
            🚨 Meine Einsätze ({myJobs.length})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'all' && styles.tabButtonActive]}
          onPress={() => setActiveTab('all')}
        >
          <Text style={[styles.tabButtonText, activeTab === 'all' && styles.tabButtonTextActive]}>
            📋 Alle Einsätze ({jobs.length})
          </Text>
        </TouchableOpacity>
      </View>

      {/* Job List */}
      <ScrollView
        style={styles.jobsScrollView}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}
      >
        {displayedJobs.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateEmoji}>🛡️</Text>
            <Text style={styles.emptyStateTitle}>
              {activeTab === 'my' ? 'Keine aktiven Zuweisungen' : 'Keine Einsätze in der Leitstelle'}
            </Text>
            <Text style={styles.emptyStateSub}>
              {activeTab === 'my'
                ? 'Sobald dich die Leitstelle einem Einsatz zuteilt, ertönt sofort der Alarm!'
                : 'Derzeit liegen keine gemeldeten Fälle vor.'}
            </Text>
          </View>
        ) : (
          displayedJobs.map((job) => {
            const isAssignedToMe = isJobAssignedToMe(job, user);
            return (
              <View
                key={job.id}
                style={[styles.jobCard, isAssignedToMe && styles.jobCardMyAssignment]}
              >
                {/* Card Header */}
                <View style={styles.jobCardHeader}>
                  <View style={styles.badgeRow}>
                    <Text
                      style={[
                        styles.statusBadge,
                        job.status === 'Offen'
                          ? styles.statusOpen
                          : job.status === 'In Bearbeitung'
                          ? styles.statusInProgress
                          : styles.statusClosed
                      ]}
                    >
                      {job.status.toUpperCase()}
                    </Text>

                    {isAssignedToMe && (
                      <Text style={styles.assignedToMeBadge}>DIR ZUGEWIESEN</Text>
                    )}
                  </View>

                  <Text style={styles.jobDate}>
                    {new Date(job.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </Text>
                </View>

                {/* Job Reason */}
                <Text style={styles.jobReason}>{job.reason}</Text>

                {/* Details */}
                <View style={styles.jobInfoBox}>
                  <Text style={styles.jobInfoRow}>
                    <Text style={styles.jobInfoLabel}>Betroffene Person: </Text>
                    {job.callerName} ({job.callerAge} Jahre)
                  </Text>

                  <Text style={styles.jobInfoRow}>
                    <Text style={styles.jobInfoLabel}>Vor Ort nötig: </Text>
                    {job.requiresOnSite ? 'Ja, Einsatzkraft erforderlich' : 'Nur telefonisch'}
                  </Text>

                  {job.assignedMember && (
                    <Text style={styles.jobInfoRow}>
                      <Text style={styles.jobInfoLabel}>Mitarbeiter: </Text>
                      {job.assignedMember.member?.name || 'Unbekannt'}
                      {job.assignedMember.distance !== undefined
                        ? ` (${job.assignedMember.distance.toFixed(1)} km)`
                        : ''}
                    </Text>
                  )}
                </View>

                {/* Address Box */}
                <View style={styles.addressBox}>
                  <Text style={styles.addressLabel}>📍 Einsatzort:</Text>
                  <Text style={styles.addressText}>{job.callerAddress}</Text>
                </View>

                {/* Actions */}
                <View style={styles.actionButtonsRow}>
                  <TouchableOpacity
                    style={styles.navButton}
                    onPress={() => openMaps(job.callerAddress)}
                  >
                    <Text style={styles.navButtonText}>🗺️ In Karte öffnen</Text>
                  </TouchableOpacity>

                  {job.status === 'Offen' && (
                    <TouchableOpacity
                      style={styles.statusChangeBtn}
                      onPress={() => updateJobStatus(job.id, 'In Bearbeitung')}
                    >
                      <Text style={styles.statusChangeText}>Einsatz annehmen</Text>
                    </TouchableOpacity>
                  )}

                  {job.status === 'In Bearbeitung' && (
                    <TouchableOpacity
                      style={styles.statusCompleteBtn}
                      onPress={() => updateJobStatus(job.id, 'Geschlossen')}
                    >
                      <Text style={styles.statusCompleteText}>Einsatz beenden</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* 4. NOTFALL-ALARM MODAL (Vollbild bei Zuweisung) */}
      <Modal visible={isAlarmPlaying && activeAlarmJob !== null} animationType="fade" transparent={false}>
        <SafeAreaView style={styles.emergencyScreen}>
          <StatusBar barStyle="light-content" />
          <ScrollView contentContainerStyle={styles.emergencyScroll}>
            {/* Pulsierendes Alarm-Icon */}
            <View style={styles.emergencyIconContainer}>
              <Text style={styles.emergencyIcon}>🚨</Text>
            </View>

            <Text style={styles.emergencyTitle}>NEUER EINSATZ ZUGEWIESEN!</Text>
            <Text style={styles.emergencySubtitle}>
              Die FSN Leitstelle hat dich für diesen Notfall alarmiert.
            </Text>

            {/* Einsatz-Datenkarte */}
            <View style={styles.emergencyCard}>
              <Text style={styles.emergencyReasonLabel}>Einsatzgrund:</Text>
              <Text style={styles.emergencyReason}>{activeAlarmJob?.reason}</Text>

              <View style={styles.emergencyDivider} />

              <Text style={styles.emergencyField}>
                <Text style={styles.emergencyFieldLabel}>Betroffene Person: </Text>
                {activeAlarmJob?.callerName} ({activeAlarmJob?.callerAge} Jahre)
              </Text>

              <Text style={styles.emergencyField}>
                <Text style={styles.emergencyFieldLabel}>Vor Ort: </Text>
                {activeAlarmJob?.requiresOnSite ? 'Ja, Anfahrt erforderlich' : 'Beratung'}
              </Text>

              {activeAlarmJob?.assignedMember?.distance !== undefined && (
                <Text style={styles.emergencyField}>
                  <Text style={styles.emergencyFieldLabel}>Entfernung: </Text>
                  {activeAlarmJob.assignedMember.distance.toFixed(1)} km
                </Text>
              )}

              <View style={styles.emergencyAddressBox}>
                <Text style={styles.emergencyAddressLabel}>📍 Adresse:</Text>
                <Text style={styles.emergencyAddressText}>{activeAlarmJob?.callerAddress}</Text>
              </View>
            </View>

            {/* Aktionen im Alarm */}
            <TouchableOpacity style={styles.emergencyDismissBtn} onPress={stopAlarm}>
              <Text style={styles.emergencyDismissText}>🛑 ALARM STOPPEN & QUITTIEREN</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.emergencyNavBtn}
              onPress={() => {
                if (activeAlarmJob) openMaps(activeAlarmJob.callerAddress);
              }}
            >
              <Text style={styles.emergencyNavText}>🗺️ In Karten-App navigieren</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.emergencyAcceptBtn}
              onPress={() => {
                if (activeAlarmJob) {
                  updateJobStatus(activeAlarmJob.id, 'In Bearbeitung');
                }
              }}
            >
              <Text style={styles.emergencyAcceptText}>⚡ Status: In Bearbeitung setzen</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Splash Screen
  splashContainer: {
    flex: 1,
    backgroundColor: '#3b103c',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20
  },
  splashIcon: {
    fontSize: 70,
    marginBottom: 15
  },
  splashTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#ffffff',
    letterSpacing: 0.5
  },
  splashSubtitle: {
    fontSize: 14,
    color: '#f5c6cb',
    marginTop: 6
  },
  splashLoadingText: {
    color: '#e0d0e0',
    marginTop: 15,
    fontSize: 14
  },

  // Login
  loginContainer: {
    flex: 1,
    backgroundColor: '#f8f9fa'
  },
  loginScroll: {
    padding: 24,
    justifyContent: 'center',
    minHeight: '100%'
  },
  loginHeader: {
    alignItems: 'center',
    marginBottom: 28
  },
  loginBadge: {
    backgroundColor: '#fae8eb',
    color: '#c0392b',
    fontSize: 11,
    fontWeight: 'bold',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 10,
    letterSpacing: 0.5
  },
  loginTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#4A154B',
    marginBottom: 8
  },
  loginSubtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    paddingHorizontal: 20
  },
  loginCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    marginBottom: 6,
    marginTop: 10
  },
  input: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    color: '#111'
  },
  loginButton: {
    backgroundColor: '#4A154B',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 22
  },
  loginButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold'
  },
  autoLoginHint: {
    color: '#27ae60',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 14,
    fontWeight: '500'
  },
  serverSettingsBtn: {
    marginTop: 25,
    alignItems: 'center'
  },
  serverSettingsText: {
    fontSize: 12,
    color: '#888',
    textDecorationLine: 'underline'
  },

  // Modal Settings
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 20
  },
  modalCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 22
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
    color: '#333'
  },
  modalSub: {
    fontSize: 12,
    color: '#666',
    marginBottom: 16
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    marginBottom: 18
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10
  },
  modalBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8
  },
  modalBtnCancel: {
    backgroundColor: '#eee'
  },
  modalBtnCancelText: {
    color: '#444',
    fontWeight: '600'
  },
  modalBtnSave: {
    backgroundColor: '#4A154B'
  },
  modalBtnSaveText: {
    color: 'white',
    fontWeight: 'bold'
  },

  // Main Dashboard
  mainContainer: {
    flex: 1,
    backgroundColor: '#f3f4f6'
  },
  topHeader: {
    backgroundColor: '#4A154B',
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  topHeaderLeft: {
    flex: 1
  },
  topHeaderTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: 'bold'
  },
  topHeaderUser: {
    color: '#f5c6cb',
    fontSize: 13,
    marginTop: 2
  },
  topHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  testAlarmBtn: {
    backgroundColor: '#e67e22',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8
  },
  testAlarmText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold'
  },
  logoutBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8
  },
  logoutBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600'
  },

  // Sync Banner
  syncBanner: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb'
  },
  syncIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  syncDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  syncDotLive: {
    backgroundColor: '#10b981'
  },
  syncDotActive: {
    backgroundColor: '#f59e0b'
  },
  syncText: {
    fontSize: 12,
    color: '#4b5563',
    fontWeight: '500'
  },
  syncReloadText: {
    fontSize: 12,
    color: '#2563eb',
    fontWeight: '600'
  },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb'
  },
  tabButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 3,
    borderBottomColor: 'transparent'
  },
  tabButtonActive: {
    borderBottomColor: '#4A154B'
  },
  tabButtonText: {
    fontSize: 14,
    color: '#6b7280',
    fontWeight: '600'
  },
  tabButtonTextActive: {
    color: '#4A154B',
    fontWeight: 'bold'
  },

  // Job Cards
  jobsScrollView: {
    flex: 1,
    padding: 14
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 30
  },
  emptyStateEmoji: {
    fontSize: 50,
    marginBottom: 12
  },
  emptyStateTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#374151',
    textAlign: 'center',
    marginBottom: 6
  },
  emptyStateSub: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 20
  },
  jobCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  jobCardMyAssignment: {
    borderColor: '#e11d48',
    borderWidth: 2,
    backgroundColor: '#fffdfd'
  },
  jobCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center'
  },
  statusBadge: {
    fontSize: 11,
    fontWeight: 'bold',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden'
  },
  statusOpen: {
    backgroundColor: '#fee2e2',
    color: '#dc2626'
  },
  statusInProgress: {
    backgroundColor: '#fef3c7',
    color: '#d97706'
  },
  statusClosed: {
    backgroundColor: '#e5e7eb',
    color: '#4b5563'
  },
  assignedToMeBadge: {
    backgroundColor: '#ffe4e6',
    color: '#e11d48',
    fontSize: 10,
    fontWeight: 'bold',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden'
  },
  jobDate: {
    fontSize: 12,
    color: '#9ca3af'
  },
  jobReason: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 10
  },
  jobInfoBox: {
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10
  },
  jobInfoRow: {
    fontSize: 13,
    color: '#374151',
    marginBottom: 4
  },
  jobInfoLabel: {
    fontWeight: 'bold',
    color: '#1f2937'
  },
  addressBox: {
    backgroundColor: '#eff6ff',
    borderRadius: 8,
    padding: 10,
    marginBottom: 14,
    borderLeftWidth: 3,
    borderLeftColor: '#3b82f6'
  },
  addressLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#1e40af',
    marginBottom: 2
  },
  addressText: {
    fontSize: 13,
    color: '#1e3a8a',
    lineHeight: 18
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 8
  },
  navButton: {
    flex: 1,
    backgroundColor: '#2563eb',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center'
  },
  navButtonText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13
  },
  statusChangeBtn: {
    backgroundColor: '#059669',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center'
  },
  statusChangeText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13
  },
  statusCompleteBtn: {
    backgroundColor: '#4b5563',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center'
  },
  statusCompleteText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13
  },

  // Emergency Alarm Fullscreen
  emergencyScreen: {
    flex: 1,
    backgroundColor: '#7f1d1d'
  },
  emergencyScroll: {
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100%'
  },
  emergencyIconContainer: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#dc2626',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 4,
    borderColor: '#fca5a5'
  },
  emergencyIcon: {
    fontSize: 50
  },
  emergencyTitle: {
    fontSize: 26,
    fontWeight: '900',
    color: '#ffffff',
    textAlign: 'center',
    letterSpacing: 0.5,
    marginBottom: 8
  },
  emergencySubtitle: {
    fontSize: 14,
    color: '#fecaca',
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 10
  },
  emergencyCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 8
  },
  emergencyReasonLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#991b1b',
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  emergencyReason: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    marginTop: 4,
    marginBottom: 10
  },
  emergencyDivider: {
    height: 1,
    backgroundColor: '#e5e7eb',
    marginVertical: 10
  },
  emergencyField: {
    fontSize: 14,
    color: '#374151',
    marginBottom: 6
  },
  emergencyFieldLabel: {
    fontWeight: 'bold',
    color: '#111827'
  },
  emergencyAddressBox: {
    backgroundColor: '#fee2e2',
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#dc2626'
  },
  emergencyAddressLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#991b1b',
    marginBottom: 3
  },
  emergencyAddressText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#7f1d1d',
    lineHeight: 20
  },
  emergencyDismissBtn: {
    backgroundColor: '#dc2626',
    borderWidth: 2,
    borderColor: '#ffffff',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 20,
    width: '100%',
    alignItems: 'center',
    marginBottom: 12
  },
  emergencyDismissText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 0.5
  },
  emergencyNavBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 14,
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center',
    marginBottom: 10
  },
  emergencyNavText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: 'bold'
  },
  emergencyAcceptBtn: {
    backgroundColor: '#059669',
    borderRadius: 14,
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center'
  },
  emergencyAcceptText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: 'bold'
  }
});
