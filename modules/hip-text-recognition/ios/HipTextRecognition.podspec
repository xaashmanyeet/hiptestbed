Pod::Spec.new do |s|
  s.name           = 'HipTextRecognition'
  s.version        = '1.0.0'
  s.summary        = 'On-device text recognition using Apple Vision.'
  s.description    = 'Reads text and word positions from an image, entirely on the device.'
  s.author         = ''
  s.homepage       = 'https://example.com'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
