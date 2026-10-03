import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Alert, ScrollView, Linking, AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Sound from 'react-native-sound';
import axios from 'axios';

// Replace this with your actual backend URL in production
const API_BASE_URL = 'http://192.168.178.69:3001/api'; 
// Note: using local IP is important for Expo Go testing, update to the production URL later.

// Enable playback in silence mode
Sound.setCategory('Playback');

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  
  const [jobs, setJobs] = useState<any[]>([]);
  const [alarmSound, setAlarmSound] = useState<Sound | null>(null);
  
  const knownJobIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    loadUser();
    
    // Load alarm sound
    const alarm = new Sound('https://cdn.freesound.org/previews/316/316847_4939433-lq.mp3', undefined, (error) => {
      if (error) {
        console.error("Failed to load sound", error);
        return;
      }
    });
    setAlarmSound(alarm);
    
    return () => {
      if (alarm) {
        alarm.release();
      }
    };
  }, []);

  const loadUser = async () => {
    try {
      const storedToken = await AsyncStorage.getItem('token');
      const storedUser = await AsyncStorage.getItem('user');
      if (storedToken && storedUser) {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleLogin = async () => {
    try {
      const res = await axios.post(`${API_BASE_URL}/auth/login`, { username, password });
      if (res.data.token) {
        await AsyncStorage.setItem('token', res.data.token);
        await AsyncStorage.setItem('user', JSON.stringify(res.data.user));
        setToken(res.data.token);
        setUser(res.data.user);
      }
    } catch (err: any) {
      Alert.alert('Fehler', err.response?.data?.error || 'Login fehlgeschlagen');
    }
  };

  const handleLogout = async () => {
    await AsyncStorage.removeItem('token');
    await AsyncStorage.removeItem('user');
    setToken(null);
    setUser(null);
    knownJobIds.current.clear();
  };

  const playAlarm = async () => {
    if (alarmSound) {
      try {
        alarmSound.play((success) => {
          if (!success) {
            console.error('Sound playback failed');
          }
        });
      } catch (err) {
        console.error("Failed to play alarm", err);
      }
    }
  };

  const fetchJobs = async () => {
    if (!token || !user) return;
    try {
      const res = await axios.get(`${API_BASE_URL}/jobs`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const allJobs = res.data;
      // Filter for jobs assigned to this user
      const myJobs = allJobs.filter((job: any) => job.assignedMember?.member?.id === user.id);
      
      setJobs(myJobs);

      // Check for new jobs
      let newJobFound = false;
      myJobs.forEach((job: any) => {
        if (!knownJobIds.current.has(job.id)) {
          knownJobIds.current.add(job.id);
          newJobFound = true;
        }
      });
      
      if (newJobFound) {
        playAlarm();
        Alert.alert("NEUER EINSATZ", "Du wurdest einem neuen Dispatch zugewiesen!");
      }
    } catch (err) {
      console.error("Failed to fetch jobs", err);
    }
  };

  useEffect(() => {
    let interval: any;
    if (token) {
      fetchJobs(); // initial fetch
      interval = setInterval(fetchJobs, 5000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [token]);

  const openMaps = (address: string) => {
    // Generate map link based on platform
    const encodedAddress = encodeURIComponent(address);
    let url = '';
    
    if (Platform.OS === 'ios') {
      url = `http://maps.apple.com/?q=${encodedAddress}`;
    } else {
      url = `https://www.google.com/maps/search/?api=1&query=${encodedAddress}`;
    }
    
    Linking.canOpenURL(url).then(supported => {
      if (supported) {
        Linking.openURL(url);
      } else {
        Alert.alert("Fehler", "Maps konnte nicht geöffnet werden.");
      }
    });
  };

  if (!token) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>FSN Dispatcher Login</Text>
        <TextInput 
          style={styles.input} 
          placeholder="Name oder E-Mail" 
          value={username} 
          onChangeText={setUsername} 
          autoCapitalize="none"
        />
        <TextInput 
          style={styles.input} 
          placeholder="Passwort" 
          secureTextEntry 
          value={password} 
          onChangeText={setPassword} 
        />
        <TouchableOpacity style={styles.button} onPress={handleLogin}>
          <Text style={styles.buttonText}>Anmelden</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Einsätze ({user?.name})</Text>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutButton}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.jobList}>
        {jobs.length === 0 ? (
          <Text style={styles.noJobsText}>Derzeit keine aktiven Zuweisungen.</Text>
        ) : (
          jobs.map(job => (
            <View key={job.id} style={styles.jobCard}>
              <View style={styles.jobHeader}>
                <Text style={styles.jobStatus}>{job.status}</Text>
                <Text style={styles.jobDate}>{new Date(job.createdAt).toLocaleString()}</Text>
              </View>
              
              <Text style={styles.jobTitle}>Einsatzgrund: {job.reason}</Text>
              <Text style={styles.jobDetail}>Betroffene Person: {job.callerName} (Alter: {job.callerAge})</Text>
              <Text style={styles.jobDetail}>Vor Ort nötig: {job.requiresOnSite ? 'Ja' : 'Nein'}</Text>
              
              <Text style={styles.jobLabel}>Adresse:</Text>
              <Text style={styles.jobAddress}>{job.callerAddress}</Text>

              <TouchableOpacity style={styles.mapButton} onPress={() => openMaps(job.callerAddress)}>
                <Text style={styles.buttonText}>In Maps öffnen 🗺️</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    paddingTop: 50,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#4A154B',
    textAlign: 'center',
    marginBottom: 30,
    marginTop: 50
  },
  input: {
    backgroundColor: 'white',
    padding: 15,
    marginHorizontal: 20,
    marginBottom: 15,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd'
  },
  button: {
    backgroundColor: '#4A154B',
    padding: 15,
    marginHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 10
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 16
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd'
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#4A154B'
  },
  logoutButton: {
    padding: 8,
    backgroundColor: '#e74c3c',
    borderRadius: 6
  },
  logoutText: {
    color: 'white',
    fontWeight: 'bold'
  },
  jobList: {
    padding: 20,
  },
  noJobsText: {
    textAlign: 'center',
    color: '#666',
    marginTop: 50,
    fontSize: 16
  },
  jobCard: {
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 12,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3
  },
  jobHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  jobStatus: {
    fontWeight: 'bold',
    color: '#e67e22',
    backgroundColor: '#fef5e7',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    overflow: 'hidden'
  },
  jobDate: {
    color: '#888',
    fontSize: 12
  },
  jobTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 5
  },
  jobDetail: {
    fontSize: 14,
    color: '#555',
    marginBottom: 5
  },
  jobLabel: {
    fontWeight: 'bold',
    marginTop: 10,
    color: '#333'
  },
  jobAddress: {
    fontSize: 14,
    color: '#666',
    marginBottom: 15
  },
  mapButton: {
    backgroundColor: '#2980b9',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center'
  }
});
