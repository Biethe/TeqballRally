#include <stddef.h>
static const char empty_str[] = "";
static const char err_str[] = "stub ALSA: no audio";
const char *snd_strerror(int e) { (void)e; return err_str; }
int snd_card_next(int *card) { if (card) *card = -1; return 0; }
const char *snd_pcm_name(void *p) { (void)p; return empty_str; }
const char *snd_ctl_card_info_get_name(void *p) { (void)p; return empty_str; }
const char *snd_ctl_card_info_get_longname(void *p) { (void)p; return empty_str; }
const char *snd_ctl_card_info_get_driver(void *p) { (void)p; return empty_str; }
const char *snd_seq_client_info_get_name(void *p) { (void)p; return empty_str; }
const char *snd_seq_port_info_get_name(void *p) { (void)p; return empty_str; }
const char *snd_mixer_selem_get_name(void *p) { (void)p; return empty_str; }
void *snd_device_name_get_hint(void *h, const char *n) { (void)h; (void)n; return NULL; }
long snd_pcm_format_size(int f, long s) { (void)f; return s > 0 ? 2 : -1; }
long snd_pcm_hw_params_sizeof(void) { return 256; }
long snd_pcm_sw_params_sizeof(void) { return 256; }
long snd_ctl_card_info_sizeof(void) { return 256; }
long snd_hwdep_info_sizeof(void) { return 256; }
long snd_seq_client_info_sizeof(void) { return 256; }
long snd_seq_port_info_sizeof(void) { return 256; }
long snd_seq_port_subscribe_sizeof(void) { return 256; }
long snd_ctl_card_info(void) { return -1; }
long snd_ctl_close(void) { return -1; }
long snd_ctl_hwdep_info(void) { return -1; }
long snd_ctl_hwdep_next_device(void) { return -1; }
long snd_ctl_open(void) { return -1; }
long snd_ctl_rawmidi_next_device(void) { return -1; }
long snd_device_name_free_hint(void) { return -1; }
long snd_device_name_hint(void) { return -1; }
long snd_hwdep_info_get_iface(void) { return -1; }
long snd_midi_event_decode(void) { return -1; }
long snd_midi_event_encode_byte(void) { return -1; }
long snd_midi_event_free(void) { return -1; }
long snd_midi_event_new(void) { return -1; }
long snd_midi_event_no_status(void) { return -1; }
long snd_mixer_attach(void) { return -1; }
long snd_mixer_close(void) { return -1; }
long snd_mixer_detach(void) { return -1; }
long snd_mixer_elem_get_callback_private(void) { return -1; }
long snd_mixer_elem_next(void) { return -1; }
long snd_mixer_elem_set_callback(void) { return -1; }
long snd_mixer_elem_set_callback_private(void) { return -1; }
long snd_mixer_find_selem(void) { return -1; }
long snd_mixer_first_elem(void) { return -1; }
long snd_mixer_free(void) { return -1; }
long snd_mixer_handle_events(void) { return -1; }
long snd_mixer_load(void) { return -1; }
long snd_mixer_open(void) { return -1; }
long snd_mixer_poll_descriptors(void) { return -1; }
long snd_mixer_poll_descriptors_count(void) { return -1; }
long snd_mixer_selem_ask_playback_dB_vol(void) { return -1; }
long snd_mixer_selem_ask_playback_vol_dB(void) { return -1; }
long snd_mixer_selem_get_capture_volume(void) { return -1; }
long snd_mixer_selem_get_capture_volume_range(void) { return -1; }
long snd_mixer_selem_get_playback_switch(void) { return -1; }
long snd_mixer_selem_get_playback_volume(void) { return -1; }
long snd_mixer_selem_get_playback_volume_range(void) { return -1; }
long snd_mixer_selem_has_capture_volume(void) { return -1; }
long snd_mixer_selem_has_playback_switch(void) { return -1; }
long snd_mixer_selem_has_playback_volume(void) { return -1; }
long snd_mixer_selem_id_free(void) { return -1; }
long snd_mixer_selem_id_malloc(void) { return -1; }
long snd_mixer_selem_id_set_index(void) { return -1; }
long snd_mixer_selem_id_set_name(void) { return -1; }
long snd_mixer_selem_is_active(void) { return -1; }
long snd_mixer_selem_register(void) { return -1; }
long snd_mixer_selem_set_capture_volume_all(void) { return -1; }
long snd_mixer_selem_set_playback_switch(void) { return -1; }
long snd_mixer_selem_set_playback_switch_all(void) { return -1; }
long snd_mixer_selem_set_playback_volume_all(void) { return -1; }
long snd_pcm_avail_update(void) { return -1; }
long snd_pcm_close(void) { return -1; }
long snd_pcm_delay(void) { return -1; }
long snd_pcm_drain(void) { return -1; }
long snd_pcm_drop(void) { return -1; }
long snd_pcm_get_params(void) { return -1; }
long snd_pcm_hw_params(void) { return -1; }
long snd_pcm_hw_params_any(void) { return -1; }
long snd_pcm_hw_params_can_resume(void) { return -1; }
long snd_pcm_hw_params_free(void) { return -1; }
long snd_pcm_hw_params_malloc(void) { return -1; }
long snd_pcm_hw_params_set_access(void) { return -1; }
long snd_pcm_hw_params_set_channels(void) { return -1; }
long snd_pcm_hw_params_set_format(void) { return -1; }
long snd_pcm_hw_params_set_rate_resample(void) { return -1; }
long snd_pcm_hw_params_test_format(void) { return -1; }
long snd_pcm_open(void) { return -1; }
long snd_pcm_prepare(void) { return -1; }
long snd_pcm_readi(void) { return -1; }
long snd_pcm_recover(void) { return -1; }
long snd_pcm_resume(void) { return -1; }
long snd_pcm_set_params(void) { return -1; }
long snd_pcm_start(void) { return -1; }
long snd_pcm_state(void) { return -1; }
long snd_pcm_sw_params(void) { return -1; }
long snd_pcm_sw_params_current(void) { return -1; }
long snd_pcm_sw_params_free(void) { return -1; }
long snd_pcm_sw_params_malloc(void) { return -1; }
long snd_pcm_sw_params_set_avail_min(void) { return -1; }
long snd_pcm_sw_params_set_start_threshold(void) { return -1; }
long snd_pcm_writei(void) { return -1; }
long snd_seq_client_id(void) { return -1; }
long snd_seq_client_info_get_client(void) { return -1; }
long snd_seq_client_info_get_type(void) { return -1; }
long snd_seq_client_info_set_client(void) { return -1; }
long snd_seq_close(void) { return -1; }
long snd_seq_create_simple_port(void) { return -1; }
long snd_seq_delete_simple_port(void) { return -1; }
long snd_seq_event_input(void) { return -1; }
long snd_seq_event_input_pending(void) { return -1; }
long snd_seq_event_output_direct(void) { return -1; }
long snd_seq_get_any_client_info(void) { return -1; }
long snd_seq_get_any_port_info(void) { return -1; }
long snd_seq_open(void) { return -1; }
long snd_seq_poll_descriptors(void) { return -1; }
long snd_seq_port_info_get_addr(void) { return -1; }
long snd_seq_port_info_get_capability(void) { return -1; }
long snd_seq_port_info_get_type(void) { return -1; }
long snd_seq_port_info_set_client(void) { return -1; }
long snd_seq_port_info_set_port(void) { return -1; }
long snd_seq_port_subscribe_set_dest(void) { return -1; }
long snd_seq_port_subscribe_set_sender(void) { return -1; }
long snd_seq_query_next_client(void) { return -1; }
long snd_seq_query_next_port(void) { return -1; }
long snd_seq_set_client_name(void) { return -1; }
long snd_seq_subscribe_port(void) { return -1; }
long snd_pcm_hw_params_get_channels_min(void) { return -1; }
long snd_pcm_hw_params_set_buffer_size_near(void) { return -1; }
long snd_pcm_hw_params_set_period_size_near(void) { return -1; }
long snd_pcm_hw_params_set_rate_near(void) { return -1; }
__asm__(".symver snd_card_next,snd_card_next@ALSA_0.9");
__asm__(".symver snd_ctl_card_info,snd_ctl_card_info@ALSA_0.9");
__asm__(".symver snd_ctl_card_info_get_driver,snd_ctl_card_info_get_driver@ALSA_0.9");
__asm__(".symver snd_ctl_card_info_get_longname,snd_ctl_card_info_get_longname@ALSA_0.9");
__asm__(".symver snd_ctl_card_info_get_name,snd_ctl_card_info_get_name@ALSA_0.9");
__asm__(".symver snd_ctl_card_info_sizeof,snd_ctl_card_info_sizeof@ALSA_0.9");
__asm__(".symver snd_ctl_close,snd_ctl_close@ALSA_0.9");
__asm__(".symver snd_ctl_hwdep_info,snd_ctl_hwdep_info@ALSA_0.9");
__asm__(".symver snd_ctl_hwdep_next_device,snd_ctl_hwdep_next_device@ALSA_0.9");
__asm__(".symver snd_ctl_open,snd_ctl_open@ALSA_0.9");
__asm__(".symver snd_ctl_rawmidi_next_device,snd_ctl_rawmidi_next_device@ALSA_0.9");
__asm__(".symver snd_device_name_free_hint,snd_device_name_free_hint@ALSA_0.9");
__asm__(".symver snd_device_name_get_hint,snd_device_name_get_hint@ALSA_0.9");
__asm__(".symver snd_device_name_hint,snd_device_name_hint@ALSA_0.9");
__asm__(".symver snd_hwdep_info_get_iface,snd_hwdep_info_get_iface@ALSA_0.9");
__asm__(".symver snd_hwdep_info_sizeof,snd_hwdep_info_sizeof@ALSA_0.9");
__asm__(".symver snd_midi_event_decode,snd_midi_event_decode@ALSA_0.9");
__asm__(".symver snd_midi_event_encode_byte,snd_midi_event_encode_byte@ALSA_0.9");
__asm__(".symver snd_midi_event_free,snd_midi_event_free@ALSA_0.9");
__asm__(".symver snd_midi_event_new,snd_midi_event_new@ALSA_0.9");
__asm__(".symver snd_midi_event_no_status,snd_midi_event_no_status@ALSA_0.9");
__asm__(".symver snd_mixer_attach,snd_mixer_attach@ALSA_0.9");
__asm__(".symver snd_mixer_close,snd_mixer_close@ALSA_0.9");
__asm__(".symver snd_mixer_detach,snd_mixer_detach@ALSA_0.9");
__asm__(".symver snd_mixer_elem_get_callback_private,snd_mixer_elem_get_callback_private@ALSA_0.9");
__asm__(".symver snd_mixer_elem_next,snd_mixer_elem_next@ALSA_0.9");
__asm__(".symver snd_mixer_elem_set_callback,snd_mixer_elem_set_callback@ALSA_0.9");
__asm__(".symver snd_mixer_elem_set_callback_private,snd_mixer_elem_set_callback_private@ALSA_0.9");
__asm__(".symver snd_mixer_find_selem,snd_mixer_find_selem@ALSA_0.9");
__asm__(".symver snd_mixer_first_elem,snd_mixer_first_elem@ALSA_0.9");
__asm__(".symver snd_mixer_free,snd_mixer_free@ALSA_0.9");
__asm__(".symver snd_mixer_handle_events,snd_mixer_handle_events@ALSA_0.9");
__asm__(".symver snd_mixer_load,snd_mixer_load@ALSA_0.9");
__asm__(".symver snd_mixer_open,snd_mixer_open@ALSA_0.9");
__asm__(".symver snd_mixer_poll_descriptors,snd_mixer_poll_descriptors@ALSA_0.9");
__asm__(".symver snd_mixer_poll_descriptors_count,snd_mixer_poll_descriptors_count@ALSA_0.9");
__asm__(".symver snd_mixer_selem_ask_playback_dB_vol,snd_mixer_selem_ask_playback_dB_vol@ALSA_0.9");
__asm__(".symver snd_mixer_selem_ask_playback_vol_dB,snd_mixer_selem_ask_playback_vol_dB@ALSA_0.9");
__asm__(".symver snd_mixer_selem_get_capture_volume,snd_mixer_selem_get_capture_volume@ALSA_0.9");
__asm__(".symver snd_mixer_selem_get_capture_volume_range,snd_mixer_selem_get_capture_volume_range@ALSA_0.9");
__asm__(".symver snd_mixer_selem_get_name,snd_mixer_selem_get_name@ALSA_0.9");
__asm__(".symver snd_mixer_selem_get_playback_switch,snd_mixer_selem_get_playback_switch@ALSA_0.9");
__asm__(".symver snd_mixer_selem_get_playback_volume,snd_mixer_selem_get_playback_volume@ALSA_0.9");
__asm__(".symver snd_mixer_selem_get_playback_volume_range,snd_mixer_selem_get_playback_volume_range@ALSA_0.9");
__asm__(".symver snd_mixer_selem_has_capture_volume,snd_mixer_selem_has_capture_volume@ALSA_0.9");
__asm__(".symver snd_mixer_selem_has_playback_switch,snd_mixer_selem_has_playback_switch@ALSA_0.9");
__asm__(".symver snd_mixer_selem_has_playback_volume,snd_mixer_selem_has_playback_volume@ALSA_0.9");
__asm__(".symver snd_mixer_selem_id_free,snd_mixer_selem_id_free@ALSA_0.9");
__asm__(".symver snd_mixer_selem_id_malloc,snd_mixer_selem_id_malloc@ALSA_0.9");
__asm__(".symver snd_mixer_selem_id_set_index,snd_mixer_selem_id_set_index@ALSA_0.9");
__asm__(".symver snd_mixer_selem_id_set_name,snd_mixer_selem_id_set_name@ALSA_0.9");
__asm__(".symver snd_mixer_selem_is_active,snd_mixer_selem_is_active@ALSA_0.9");
__asm__(".symver snd_mixer_selem_register,snd_mixer_selem_register@ALSA_0.9");
__asm__(".symver snd_mixer_selem_set_capture_volume_all,snd_mixer_selem_set_capture_volume_all@ALSA_0.9");
__asm__(".symver snd_mixer_selem_set_playback_switch,snd_mixer_selem_set_playback_switch@ALSA_0.9");
__asm__(".symver snd_mixer_selem_set_playback_switch_all,snd_mixer_selem_set_playback_switch_all@ALSA_0.9");
__asm__(".symver snd_mixer_selem_set_playback_volume_all,snd_mixer_selem_set_playback_volume_all@ALSA_0.9");
__asm__(".symver snd_pcm_avail_update,snd_pcm_avail_update@ALSA_0.9");
__asm__(".symver snd_pcm_close,snd_pcm_close@ALSA_0.9");
__asm__(".symver snd_pcm_delay,snd_pcm_delay@ALSA_0.9");
__asm__(".symver snd_pcm_drain,snd_pcm_drain@ALSA_0.9");
__asm__(".symver snd_pcm_drop,snd_pcm_drop@ALSA_0.9");
__asm__(".symver snd_pcm_format_size,snd_pcm_format_size@ALSA_0.9");
__asm__(".symver snd_pcm_get_params,snd_pcm_get_params@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params,snd_pcm_hw_params@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_any,snd_pcm_hw_params_any@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_can_resume,snd_pcm_hw_params_can_resume@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_free,snd_pcm_hw_params_free@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_malloc,snd_pcm_hw_params_malloc@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_set_access,snd_pcm_hw_params_set_access@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_set_channels,snd_pcm_hw_params_set_channels@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_set_format,snd_pcm_hw_params_set_format@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_set_rate_resample,snd_pcm_hw_params_set_rate_resample@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_test_format,snd_pcm_hw_params_test_format@ALSA_0.9");
__asm__(".symver snd_pcm_name,snd_pcm_name@ALSA_0.9");
__asm__(".symver snd_pcm_open,snd_pcm_open@ALSA_0.9");
__asm__(".symver snd_pcm_prepare,snd_pcm_prepare@ALSA_0.9");
__asm__(".symver snd_pcm_readi,snd_pcm_readi@ALSA_0.9");
__asm__(".symver snd_pcm_recover,snd_pcm_recover@ALSA_0.9");
__asm__(".symver snd_pcm_resume,snd_pcm_resume@ALSA_0.9");
__asm__(".symver snd_pcm_set_params,snd_pcm_set_params@ALSA_0.9");
__asm__(".symver snd_pcm_start,snd_pcm_start@ALSA_0.9");
__asm__(".symver snd_pcm_state,snd_pcm_state@ALSA_0.9");
__asm__(".symver snd_pcm_sw_params,snd_pcm_sw_params@ALSA_0.9");
__asm__(".symver snd_pcm_sw_params_current,snd_pcm_sw_params_current@ALSA_0.9");
__asm__(".symver snd_pcm_sw_params_free,snd_pcm_sw_params_free@ALSA_0.9");
__asm__(".symver snd_pcm_sw_params_malloc,snd_pcm_sw_params_malloc@ALSA_0.9");
__asm__(".symver snd_pcm_sw_params_set_avail_min,snd_pcm_sw_params_set_avail_min@ALSA_0.9");
__asm__(".symver snd_pcm_sw_params_set_start_threshold,snd_pcm_sw_params_set_start_threshold@ALSA_0.9");
__asm__(".symver snd_pcm_writei,snd_pcm_writei@ALSA_0.9");
__asm__(".symver snd_seq_client_id,snd_seq_client_id@ALSA_0.9");
__asm__(".symver snd_seq_client_info_get_client,snd_seq_client_info_get_client@ALSA_0.9");
__asm__(".symver snd_seq_client_info_get_name,snd_seq_client_info_get_name@ALSA_0.9");
__asm__(".symver snd_seq_client_info_get_type,snd_seq_client_info_get_type@ALSA_0.9");
__asm__(".symver snd_seq_client_info_set_client,snd_seq_client_info_set_client@ALSA_0.9");
__asm__(".symver snd_seq_client_info_sizeof,snd_seq_client_info_sizeof@ALSA_0.9");
__asm__(".symver snd_seq_close,snd_seq_close@ALSA_0.9");
__asm__(".symver snd_seq_create_simple_port,snd_seq_create_simple_port@ALSA_0.9");
__asm__(".symver snd_seq_delete_simple_port,snd_seq_delete_simple_port@ALSA_0.9");
__asm__(".symver snd_seq_event_input,snd_seq_event_input@ALSA_0.9");
__asm__(".symver snd_seq_event_input_pending,snd_seq_event_input_pending@ALSA_0.9");
__asm__(".symver snd_seq_event_output_direct,snd_seq_event_output_direct@ALSA_0.9");
__asm__(".symver snd_seq_get_any_client_info,snd_seq_get_any_client_info@ALSA_0.9");
__asm__(".symver snd_seq_get_any_port_info,snd_seq_get_any_port_info@ALSA_0.9");
__asm__(".symver snd_seq_open,snd_seq_open@ALSA_0.9");
__asm__(".symver snd_seq_poll_descriptors,snd_seq_poll_descriptors@ALSA_0.9");
__asm__(".symver snd_seq_port_info_get_addr,snd_seq_port_info_get_addr@ALSA_0.9");
__asm__(".symver snd_seq_port_info_get_capability,snd_seq_port_info_get_capability@ALSA_0.9");
__asm__(".symver snd_seq_port_info_get_name,snd_seq_port_info_get_name@ALSA_0.9");
__asm__(".symver snd_seq_port_info_get_type,snd_seq_port_info_get_type@ALSA_0.9");
__asm__(".symver snd_seq_port_info_set_client,snd_seq_port_info_set_client@ALSA_0.9");
__asm__(".symver snd_seq_port_info_set_port,snd_seq_port_info_set_port@ALSA_0.9");
__asm__(".symver snd_seq_port_info_sizeof,snd_seq_port_info_sizeof@ALSA_0.9");
__asm__(".symver snd_seq_port_subscribe_set_dest,snd_seq_port_subscribe_set_dest@ALSA_0.9");
__asm__(".symver snd_seq_port_subscribe_set_sender,snd_seq_port_subscribe_set_sender@ALSA_0.9");
__asm__(".symver snd_seq_port_subscribe_sizeof,snd_seq_port_subscribe_sizeof@ALSA_0.9");
__asm__(".symver snd_seq_query_next_client,snd_seq_query_next_client@ALSA_0.9");
__asm__(".symver snd_seq_query_next_port,snd_seq_query_next_port@ALSA_0.9");
__asm__(".symver snd_seq_set_client_name,snd_seq_set_client_name@ALSA_0.9");
__asm__(".symver snd_seq_subscribe_port,snd_seq_subscribe_port@ALSA_0.9");
__asm__(".symver snd_strerror,snd_strerror@ALSA_0.9");
__asm__(".symver snd_pcm_hw_params_get_channels_min,snd_pcm_hw_params_get_channels_min@ALSA_0.9.0rc4");
__asm__(".symver snd_pcm_hw_params_set_buffer_size_near,snd_pcm_hw_params_set_buffer_size_near@ALSA_0.9.0rc4");
__asm__(".symver snd_pcm_hw_params_set_period_size_near,snd_pcm_hw_params_set_period_size_near@ALSA_0.9.0rc4");
__asm__(".symver snd_pcm_hw_params_set_rate_near,snd_pcm_hw_params_set_rate_near@ALSA_0.9.0rc4");
