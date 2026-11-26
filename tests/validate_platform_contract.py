"""Validate synthetic Gateway and preview outputs against published JSON Schemas."""

import json
import pathlib
import sys

from jsonschema import Draft202012Validator, ValidationError
from referencing import Registry, Resource


def main():
    root = pathlib.Path(__file__).resolve().parents[1]
    schemas = {}
    names = (
        "vehicle-control.schema.json",
        "vehicle-control-handover-ack.schema.json",
        "vehicle-media-demand.schema.json",
        "vehicle-telemetry.schema.json",
        "vehicle-operations-common.schema.json",
        "vehicle-operations-alert.schema.json",
        "vehicle-operations-mission.schema.json",
        "vehicle-operations-response.schema.json",
    )
    for name in names:
        schemas[name] = json.loads((root / "api/schemas" / name).read_text())
        Draft202012Validator.check_schema(schemas[name])
    registry = Registry().with_resources(
        (name, Resource.from_contents(schema)) for name, schema in schemas.items()
    )
    telemetry = Draft202012Validator(
        schemas["vehicle-telemetry.schema.json"], registry=registry
    )
    operations = Draft202012Validator(
        schemas["vehicle-operations-response.schema.json"], registry=registry
    )
    alert = Draft202012Validator(
        schemas["vehicle-operations-alert.schema.json"], registry=registry
    )
    mission = Draft202012Validator(
        schemas["vehicle-operations-mission.schema.json"], registry=registry
    )
    corpus = json.loads(pathlib.Path(sys.argv[1]).read_text())
    for scenario in corpus:
        try:
            operations.validate(scenario["operations"])
            for item in scenario["operations"]["alerts"]:
                alert.validate(item)
            for item in scenario["operations"]["missions"]:
                mission.validate(item)
            if scenario["entry"]["state"] is not None:
                telemetry.validate(scenario["entry"]["state"])
        except ValidationError as error:
            # Add the scenario name without converting a validation error to success.
            raise RuntimeError(f"Schema mismatch: {scenario['name']}") from error
    print(f"Published JSON Schemas: {len(corpus)} Gateway/preview snapshots passed")


if __name__ == "__main__":
    main()
