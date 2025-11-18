const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let supabaseAnon = null;
let supabaseAdmin = null;

function initClients() {
  try {
    if (url && anonKey) {
      supabaseAnon = createClient(url, anonKey, { auth: { persistSession: false } });
    }
    if (url && serviceKey) {
      supabaseAdmin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    }
  } catch (err) {
    console.warn(`[Supabase] Init error: ${err.message}`);
  }
}

initClients();

async function getStatus() {
  const status = { url: !!url, anon: !!supabaseAnon, admin: !!supabaseAdmin, connected: false };
  if (supabaseAdmin) {
    try {
      // Light-touch admin call to verify credentials; will fail gracefully if key invalid
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (!error) status.connected = true;
    } catch (_) {}
  }
  return status;
}

function isConfigured() {
  return !!supabaseAdmin;
}

// Map a Mongoose Video doc to Supabase row shape (snake_case)
function mapVideo(video) {
  if (!video) return null;
  const v = video.toObject ? video.toObject() : video;
  return {
    id: String(v._id),
    title: v.title || null,
    filename: v.filename || null,
    filepath: v.filepath || null,
    filesize: typeof v.filesize === 'number' ? v.filesize : null,
    duration: typeof v.duration === 'number' ? v.duration : null,
    rtmp_url: v.rtmpUrl || null,
    stream_key: v.streamKey || null,
    schedule_time: v.scheduleTime || null,
    stop_time: v.stopTime || null,
    playlist_id: v.playlistId ? String(v.playlistId) : null,
    status: v.status || null,
    progress: typeof v.progress === 'number' ? v.progress : null,
    error_message: v.errorMessage || null,
    uploaded_at: v.uploadedAt || null,
    stream_started_at: v.streamStartedAt || null,
    stream_ended_at: v.streamEndedAt || null,
    used_rtmp_url: v.usedRtmpUrl || null,
    used_stream_key: v.usedStreamKey || null,
    last_output_url: v.lastOutputUrl || null,
    created_at: v.createdAt || null,
    updated_at: v.updatedAt || null,
  };
}

// Map a Playlist doc to Supabase row shape
function mapPlaylist(pl) {
  if (!pl) return null;
  const p = pl.toObject ? pl.toObject() : pl;
  return {
    id: String(p._id),
    name: p.name || null,
    description: p.description || null,
    schedule_time: p.scheduleTime || null,
    status: p.status || null,
    current_index: typeof p.currentIndex === 'number' ? p.currentIndex : 0,
    rtmp_url: p.rtmpUrl || null,
    stream_key: p.streamKey || null,
    stream_started_at: p.streamStartedAt || null,
    stream_ended_at: p.streamEndedAt || null,
    created_at: p.createdAt || null,
    updated_at: p.updatedAt || null,
  };
}

async function syncVideo(video) {
  if (!supabaseAdmin) return false;
  try {
    const row = mapVideo(video);
    if (!row) return false;
    const { error } = await supabaseAdmin.from('videos').upsert(row, { onConflict: 'id' });
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn(`[Supabase] syncVideo error: ${err.message}`);
    return false;
  }
}

async function syncPlaylist(pl) {
  if (!supabaseAdmin) return false;
  try {
    const row = mapPlaylist(pl);
    if (!row) return false;
    const { error } = await supabaseAdmin.from('playlists').upsert(row, { onConflict: 'id' });
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn(`[Supabase] syncPlaylist error: ${err.message}`);
    return false;
  }
}

async function updateVideoProgress(videoId, progress) {
  if (!supabaseAdmin) return false;
  try {
    const { error } = await supabaseAdmin
      .from('videos')
      .update({ progress, updated_at: new Date() })
      .eq('id', String(videoId));
    if (error) throw error;
    return true;
  } catch (err) {
    // Keep silent on frequent calls
    return false;
  }
}

async function insertStreamEvent(videoId, type, payload = {}) {
  if (!supabaseAdmin) return false;
  try {
    const row = {
      video_id: String(videoId),
      type: String(type),
      created_at: new Date(),
      progress: typeof payload.progress === 'number' ? payload.progress : null,
      output_url: payload.outputUrl || null,
      message: payload.message || null,
    };
    const { error } = await supabaseAdmin.from('stream_events').insert(row);
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn(`[Supabase] insertStreamEvent error: ${err.message}`);
    return false;
  }
}

module.exports = { supabaseAnon, supabaseAdmin, getStatus, isConfigured, syncVideo, syncPlaylist, updateVideoProgress, insertStreamEvent };