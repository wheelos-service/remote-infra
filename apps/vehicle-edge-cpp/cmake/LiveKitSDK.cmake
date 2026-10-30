# Official release archive; no moving branch or system SDK fallback.
if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux" OR
   NOT CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|amd64|AMD64)$")
  message(FATAL_ERROR "Pinned LiveKit binary currently supports Linux x86_64 only")
endif()
set(_livekit_name livekit-sdk-ubuntu-22.04-x64-1.13.0)
set(_livekit_cache "${CMAKE_BINARY_DIR}/livekit-sdk")
set(_livekit_archive "${_livekit_cache}/${_livekit_name}.tar.gz")
file(MAKE_DIRECTORY "${_livekit_cache}")
file(DOWNLOAD
  "https://github.com/livekit/client-sdk-cpp/releases/download/v1.13.0/${_livekit_name}.tar.gz"
  "${_livekit_archive}"
  EXPECTED_HASH SHA256=60712578e14350689beeff36675088c8b91c1050b906441f71db312089fe8fa8
  TLS_VERIFY ON STATUS _livekit_download)
list(GET _livekit_download 0 _livekit_status)
if(NOT _livekit_status EQUAL 0)
  message(FATAL_ERROR "Could not download pinned LiveKit SDK: ${_livekit_download}")
endif()
file(DOWNLOAD
  "https://raw.githubusercontent.com/livekit/client-sdk-cpp/v1.13.0/LICENSE"
  "${_livekit_cache}/LICENSE"
  EXPECTED_HASH SHA256=09e8a9bcec8067104652c168685ab0931e7868f9c8284b66f5ae6edae5f1130b
  TLS_VERIFY ON STATUS _livekit_license_download)
list(GET _livekit_license_download 0 _livekit_license_status)
if(NOT _livekit_license_status EQUAL 0)
  message(FATAL_ERROR "Could not download pinned LiveKit license")
endif()
execute_process(COMMAND "${CMAKE_COMMAND}" -E tar xzf "${_livekit_archive}"
  WORKING_DIRECTORY "${_livekit_cache}" RESULT_VARIABLE _livekit_extract)
if(NOT _livekit_extract EQUAL 0)
  message(FATAL_ERROR "Could not extract pinned LiveKit SDK")
endif()
find_package(LiveKit 1.13.0 EXACT CONFIG REQUIRED
  PATHS "${_livekit_cache}/${_livekit_name}/lib/cmake/LiveKit"
  NO_DEFAULT_PATH)
