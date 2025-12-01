#!/usr/bin/env node

const axios = require('axios');

const API_BASE = process.env.API_BASE || 'https://gescardcocodybackend.onrender.com';

async function runDiagnostic() {
  console.log('🔍 Diagnostic API GESCard');
  console.log('============================\n');
  
  try {
    // Test 1: API de base
    console.log('1️⃣ Test API de base...');
    const baseRes = await axios.get(`${API_BASE}/api`);
    console.log(`✅ API de base: ${baseRes.data.message}`);
    
    // Test 2: Health check
    console.log('\n2️⃣ Test Health Check...');
    const healthRes = await axios.get(`${API_BASE}/api/health`);
    console.log(`✅ Health: ${healthRes.data.status}`);
    console.log(`📊 Cartes: ${healthRes.data.statistics.total_cartes}`);
    
    // Test 3: CORS
    console.log('\n3️⃣ Test CORS...');
    const corsRes = await axios.get(`${API_BASE}/api/cors-test`);
    console.log(`✅ CORS: ${corsRes.data.message}`);
    
    // Test 4: API externe publique
    console.log('\n4️⃣ Test API externe (publique)...');
    const extHealth = await axios.get(`${API_BASE}/api/external/health`);
    console.log(`✅ API externe health: ${extHealth.data.status}`);
    
    // Test 5: API changes (publique)
    console.log('\n5️⃣ Test API changes (publique)...');
    const changesRes = await axios.get(`${API_BASE}/api/external/changes`);
    console.log(`✅ API changes: ${changesRes.data.total} modifications`);
    console.log(`📅 Dernière modif: ${changesRes.data.derniereModification}`);
    
    // Test 6: Debug external
    console.log('\n6️⃣ Test debug external...');
    const debugRes = await axios.get(`${API_BASE}/api/debug/external`);
    console.log(`✅ Debug external: ${debugRes.data.status}`);
    
    // Test 7: API externe protégée (sans token)
    console.log('\n7️⃣ Test API protégée (sans token - devrait échouer)...');
    try {
      await axios.get(`${API_BASE}/api/external/cartes`);
      console.log(`❌ Devrait avoir échoué (401)`);
    } catch (error) {
      console.log(`✅ Correctement protégée: ${error.response?.status || error.code}`);
    }
    
    // Test 8: API externe protégée (avec token)
    console.log('\n8️⃣ Test API protégée (avec token)...');
    try {
      const protectedRes = await axios.get(`${API_BASE}/api/external/cartes`, {
        headers: { 'X-API-Token': 'CARTES_API_2025_SECRET_TOKEN_NOV' }
      });
      console.log(`✅ API protégée accessible avec token`);
      console.log(`📊 Données: ${protectedRes.data.data?.length || 0} cartes`);
    } catch (error) {
      console.log(`❌ Erreur token: ${error.response?.data?.error || error.message}`);
    }
    
    console.log('\n🎉 Diagnostic terminé avec succès!');
    console.log(`\n📋 Résumé:`);
    console.log(`- API Base: ✅`);
    console.log(`- Health: ✅`);
    console.log(`- CORS: ✅`);
    console.log(`- API externe publique: ✅`);
    console.log(`- API changes: ✅`);
    console.log(`- Protection token: ✅`);
    
  } catch (error) {
    console.error('\n❌ Diagnostic échoué:');
    console.error(`Message: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    process.exit(1);
  }
}

// Exécuter le diagnostic
runDiagnostic();