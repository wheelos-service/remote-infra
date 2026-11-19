package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const maxTelemetryInteger int64 = 9007199254740991

var telemetryIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

type validatedTelemetry struct {
	VehicleID string
	StreamID  string
	Sequence  int64
	Payload   json.RawMessage
}

// Keep these checks aligned with api/schemas/vehicle-telemetry.schema.json.
// Validate the JSON tree rather than zero-valued structs: required nullable
// sample fields must remain distinguishable from missing fields.
func validateVehicleTelemetry(raw []byte) (validatedTelemetry, error) {
	if err := rejectDuplicateJSONFields(raw); err != nil {
		return validatedTelemetry{}, err
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return validatedTelemetry{}, err
	}
	if err := requireJSONEnd(decoder); err != nil {
		return validatedTelemetry{}, err
	}
	obj, err := telemetryObject(value, "schema_version", "type", "vehicle_id", "stream_id", "sequence", "published_at_ms", "chassis", "localization")
	if err != nil || len(obj) != 8 {
		return validatedTelemetry{}, errors.New("invalid telemetry envelope fields")
	}
	version, ok := telemetryInteger(obj["schema_version"], 1, 1)
	if !ok || version != 1 || obj["type"] != "vehicle_telemetry" {
		return validatedTelemetry{}, errors.New("unsupported telemetry schema or type")
	}
	vehicleID, vehicleOK := obj["vehicle_id"].(string)
	streamID, streamOK := obj["stream_id"].(string)
	sequence, sequenceOK := telemetryInteger(obj["sequence"], 1, maxTelemetryInteger)
	_, publishedOK := telemetryInteger(obj["published_at_ms"], 1, maxTelemetryInteger)
	if !vehicleOK || !streamOK || !telemetryIdentifier.MatchString(vehicleID) ||
		!telemetryIdentifier.MatchString(streamID) || !sequenceOK || !publishedOK {
		return validatedTelemetry{}, errors.New("invalid telemetry identity, sequence, or timestamp")
	}
	if err := validateTelemetrySample(obj["chassis"], true); err != nil {
		return validatedTelemetry{}, fmt.Errorf("chassis: %w", err)
	}
	if err := validateTelemetrySample(obj["localization"], false); err != nil {
		return validatedTelemetry{}, fmt.Errorf("localization: %w", err)
	}
	return validatedTelemetry{VehicleID: vehicleID, StreamID: streamID, Sequence: sequence, Payload: json.RawMessage(raw)}, nil
}

func rejectDuplicateJSONFields(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var consume func(int) error
	consume = func(depth int) error {
		if depth > 32 {
			return errors.New("JSON nesting exceeds telemetry limit")
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		seen := map[string]bool{}
		for decoder.More() {
			if delimiter == '{' {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return errors.New("duplicate or invalid JSON object key")
				}
				seen[name] = true
			}
			if err := consume(depth + 1); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	}
	if err := consume(0); err != nil {
		return err
	}
	return requireJSONEnd(decoder)
}

func requireJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("expected exactly one JSON value")
	}
	return nil
}

func telemetryObject(value any, allowed ...string) (map[string]any, error) {
	obj, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("expected object")
	}
	for key := range obj {
		found := false
		for _, name := range allowed {
			if key == name {
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("unknown field %q", key)
		}
	}
	return obj, nil
}

func telemetryInteger(value any, minimum, maximum int64) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok || !finiteTelemetryNumber(number) {
		return 0, false
	}
	sign, digits, power := telemetryDecimal(number)
	if power < 0 || int64(len(digits))+power > 19 {
		return 0, false
	}
	text := digits + strings.Repeat("0", int(power))
	if sign < 0 {
		text = "-" + text
	}
	n, err := strconv.ParseInt(text, 10, 64)
	return n, err == nil && n >= minimum && n <= maximum
}

func telemetryNumber(value any, minimum, maximum *int64) bool {
	if value == nil {
		return true
	}
	number, ok := value.(json.Number)
	if !ok || !finiteTelemetryNumber(number) {
		return false
	}
	if minimum == nil && maximum == nil {
		return true
	}
	return (minimum == nil || compareTelemetryNumber(number, *minimum) >= 0) &&
		(maximum == nil || compareTelemetryNumber(number, *maximum) <= 0)
}

func finiteTelemetryNumber(number json.Number) bool {
	value, err := strconv.ParseFloat(string(number), 64)
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
		return false
	}
	sign, _, _ := telemetryDecimal(number)
	return value != 0 || sign == 0
}

// Normalize decimal JSON numbers without floats (which round boundary values)
// or exponentiation (which lets a tiny input allocate unbounded big integers).
func telemetryDecimal(number json.Number) (sign int, digits string, power int64) {
	text := string(number)
	sign = 1
	if strings.HasPrefix(text, "-") {
		sign, text = -1, text[1:]
	}
	if index := strings.IndexAny(text, "eE"); index >= 0 {
		exponent := text[index+1:]
		parsed, err := strconv.ParseInt(exponent, 10, 64)
		limit := int64(maxVehicleTelemetryBytes + 100)
		if err != nil || parsed > limit || parsed < -limit {
			parsed = limit
			if strings.HasPrefix(exponent, "-") {
				parsed = -limit
			}
		}
		power = parsed
		text = text[:index]
	}
	if index := strings.IndexByte(text, '.'); index >= 0 {
		power -= int64(len(text) - index - 1)
		text = text[:index] + text[index+1:]
	}
	digits = strings.TrimLeft(text, "0")
	if digits == "" {
		return 0, "0", 0
	}
	trimmed := strings.TrimRight(digits, "0")
	power += int64(len(digits) - len(trimmed))
	return sign, trimmed, power
}

func compareTelemetryNumber(number json.Number, bound int64) int {
	sign, digits, power := telemetryDecimal(number)
	boundSign := 0
	if bound > 0 {
		boundSign = 1
	} else if bound < 0 {
		boundSign, bound = -1, -bound
	}
	if sign < boundSign {
		return -1
	}
	if sign > boundSign {
		return 1
	}
	if sign == 0 {
		return 0
	}
	boundDigits := strconv.FormatInt(bound, 10)
	length := int64(len(digits)) + power
	if length < int64(len(boundDigits)) {
		return -sign
	}
	if length > int64(len(boundDigits)) {
		return sign
	}
	for index := 0; index < len(digits) || index < len(boundDigits); index++ {
		left, right := byte('0'), byte('0')
		if index < len(digits) {
			left = digits[index]
		}
		if index < len(boundDigits) {
			right = boundDigits[index]
		}
		if left < right {
			return -sign
		}
		if left > right {
			return sign
		}
	}
	return 0
}

func telemetryEnum(value any, allowed ...string) bool {
	if value == nil {
		return true
	}
	for _, s := range allowed {
		if value == s {
			return true
		}
	}
	return false
}

func validateTelemetrySample(value any, chassis bool) error {
	obj, err := telemetryObject(value, "age_ms", "source_timestamp_ms", "source_sequence", "message")
	if err != nil || len(obj) != 4 {
		return errors.New("sample requires age_ms, source_timestamp_ms, source_sequence, and message")
	}
	for _, field := range []struct {
		name     string
		min, max int64
	}{
		{"age_ms", 0, maxTelemetryInteger},
		{"source_timestamp_ms", 1, maxTelemetryInteger},
		{"source_sequence", 0, 4294967295},
	} {
		if obj[field.name] != nil {
			if _, ok := telemetryInteger(obj[field.name], field.min, field.max); !ok {
				return fmt.Errorf("invalid %s", field.name)
			}
		}
	}
	if obj["message"] == nil {
		return nil
	}
	if chassis {
		return validateChassisMessage(obj["message"])
	}
	return validateLocalizationMessage(obj["message"])
}

func validateChassisMessage(value any) error {
	obj, err := telemetryObject(value, "speed_mps", "gear_location", "driving_mode",
		"steering_percentage", "throttle_percentage", "brake_percentage", "battery_soc_percentage",
		"parking_brake", "error_code", "chassis_error_mask")
	if err != nil {
		return err
	}
	for name, value := range obj {
		valid := false
		switch name {
		case "speed_mps":
			valid = telemetryNumber(value, nil, nil)
		case "steering_percentage", "throttle_percentage", "brake_percentage", "battery_soc_percentage":
			minimum, maximum := int64(0), int64(100)
			if name == "steering_percentage" {
				minimum = -100
			}
			valid = telemetryNumber(value, &minimum, &maximum)
		case "gear_location":
			valid = telemetryEnum(value, "GEAR_NEUTRAL", "GEAR_DRIVE", "GEAR_REVERSE", "GEAR_PARKING", "GEAR_LOW", "GEAR_INVALID", "GEAR_NONE")
		case "driving_mode":
			valid = telemetryEnum(value, "COMPLETE_MANUAL", "COMPLETE_AUTO_DRIVE", "AUTO_STEER_ONLY", "AUTO_SPEED_ONLY", "EMERGENCY_MODE")
		case "parking_brake":
			_, valid = value.(bool)
			valid = valid || value == nil
		case "error_code":
			_, valid = telemetryInteger(value, 0, 9)
			valid = valid || value == nil
		case "chassis_error_mask":
			_, valid = telemetryInteger(value, -2147483648, 2147483647)
			valid = valid || value == nil
		}
		if !valid {
			return fmt.Errorf("invalid %s", name)
		}
	}
	return nil
}

func validateLocalizationMessage(value any) error {
	obj, err := telemetryObject(value, "position", "heading_rad", "frame_id")
	if err != nil {
		return err
	}
	for name, value := range obj {
		switch name {
		case "position":
			if value == nil {
				continue
			}
			position, err := telemetryObject(value, "x", "y", "z")
			if err != nil {
				return err
			}
			for _, coordinate := range position {
				if !telemetryNumber(coordinate, nil, nil) {
					return errors.New("invalid position coordinate")
				}
			}
		case "heading_rad":
			if !telemetryNumber(value, nil, nil) {
				return errors.New("invalid heading_rad")
			}
		case "frame_id":
			if value != nil {
				frame, ok := value.(string)
				if !ok || utf8.RuneCountInString(frame) > 128 {
					return errors.New("invalid frame_id")
				}
			}
		}
	}
	return nil
}
